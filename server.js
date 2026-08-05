require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const ExcelJS = require('exceljs');
const { pool, init } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // raised to allow base64-encoded PO document attachments
app.use(express.static(path.join(__dirname, 'public')));

const SALES_PASSWORD = process.env.SALES_PASSWORD || 'sales123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// --- Email setup ---
// Sends via Brevo's HTTPS API rather than SMTP. Railway blocks outbound
// SMTP ports (25/465/587) on Free/Trial/Hobby plans, but never blocks
// standard HTTPS (443), so this works on any Railway plan.
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const SENDER_EMAIL = process.env.SENDER_EMAIL || '';
const SENDER_NAME = process.env.SENDER_NAME || 'Order Desk';

if (BREVO_API_KEY && SENDER_EMAIL) {
  console.log('Email sending enabled via Brevo API, sender:', SENDER_EMAIL);
} else {
  console.log('Email sending disabled: BREVO_API_KEY/SENDER_EMAIL not set.');
}

async function sendMail({ to, subject, text }) {
  if (!BREVO_API_KEY || !SENDER_EMAIL) throw new Error('Email is not configured on this server yet.');
  if (!to) throw new Error('This order has no salesperson email on file.');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { email: SENDER_EMAIL, name: SENDER_NAME },
      to: [{ email: to }],
      subject,
      textContent: text
    })
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message; } catch (e) { /* ignore */ }
    throw new Error(`Brevo API error (${res.status}): ${detail || 'send failed'}`);
  }
}

function genId() {
  const n = Date.now().toString(36).toUpperCase().slice(-5);
  const r = Math.random().toString(36).toUpperCase().slice(2, 4);
  return 'ORD-' + n + r;
}

// --- Auth: simple shared-password-per-role scheme. ---
// Good enough for a small internal team. Swap for real user accounts
// (bcrypt + per-person login) once you have more than a couple of staff.
function checkAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [role, pass] = decoded.split(':');
    if (role === 'admin' && pass === ADMIN_PASSWORD) { req.role = 'admin'; return next(); }
    if (role === 'sales' && pass === SALES_PASSWORD) { req.role = 'sales'; return next(); }
  } catch (e) { /* falls through to 401 */ }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin access only' });
  next();
}

app.post('/api/login', (req, res) => {
  const { role, password } = req.body || {};
  if (role === 'admin' && password === ADMIN_PASSWORD) {
    return res.json({ token: Buffer.from(`admin:${password}`).toString('base64'), role: 'admin' });
  }
  if (role === 'sales' && password === SALES_PASSWORD) {
    return res.json({ token: Buffer.from(`sales:${password}`).toString('base64'), role: 'sales' });
  }
  res.status(401).json({ error: 'Invalid role or password' });
});

app.get('/api/orders', checkAuth, async (req, res) => {
  // Excludes po_file_data/invoice_file_data/payment_slip_file_data (base64
  // file content) from the list to keep this fast — full attachments are
  // only fetched on demand.
  const result = await pool.query(`
    SELECT id, salesperson, salesperson_email, customer, address, amount, items, notes,
           status, fulfillment, courier, tracking, history, follow_ups,
           tracking_emailed, po_number, po_file_name, po_file_type, created_at,
           invoice_file_name, invoice_file_type, is_cash_sale,
           payment_slip_file_name, payment_slip_file_type,
           (po_file_data IS NOT NULL AND po_file_data != '') AS has_po_attachment,
           (invoice_file_data IS NOT NULL AND invoice_file_data != '') AS has_invoice_attachment,
           (payment_slip_file_data IS NOT NULL AND payment_slip_file_data != '') AS has_payment_slip
    FROM orders ORDER BY created_at DESC
  `);
  res.json(result.rows);
});

// Shared filter logic for exports: optional ?status=, ?fulfillment=, ?from=, ?to= (ISO dates)
function buildFilterQuery(query) {
  const { status, fulfillment, from, to } = query;
  const clauses = [];
  const params = [];
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (fulfillment) { params.push(fulfillment); clauses.push(`fulfillment = $${params.length}`); }
  if (from) { params.push(from); clauses.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`created_at <= $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const cols = `id, salesperson, salesperson_email, customer, address, amount, items, notes,
    status, fulfillment, courier, tracking, history, follow_ups, po_number,
    po_file_name, (po_file_data IS NOT NULL AND po_file_data != '') AS has_po_attachment,
    invoice_file_name, (invoice_file_data IS NOT NULL AND invoice_file_data != '') AS has_invoice_attachment,
    is_cash_sale, payment_slip_file_name,
    (payment_slip_file_data IS NOT NULL AND payment_slip_file_data != '') AS has_payment_slip,
    created_at`;
  return { text: `SELECT ${cols} FROM orders ${where} ORDER BY created_at DESC`, params };
}

const EXPORT_COLUMNS = [
  { header: 'Order ID', key: 'id', width: 16 },
  { header: 'PO Number', key: 'po_number', width: 16 },
  { header: 'PO Attached', key: 'poAttachedLabel', width: 12 },
  { header: 'Invoice Attached', key: 'invoiceAttachedLabel', width: 14 },
  { header: 'Customer', key: 'customer', width: 24 },
  { header: 'Address', key: 'address', width: 30 },
  { header: 'Salesperson', key: 'salesperson', width: 18 },
  { header: 'Items', key: 'items', width: 34 },
  { header: 'Amount (RM)', key: 'amount', width: 14 },
  { header: 'Payment Status', key: 'status', width: 16 },
  { header: 'Cash Sale', key: 'cashSaleLabel', width: 12 },
  { header: 'Payment Slip Attached', key: 'paymentSlipAttachedLabel', width: 16 },
  { header: 'Fulfillment', key: 'fulfillment', width: 14 },
  { header: 'Courier', key: 'courier', width: 16 },
  { header: 'Tracking Link', key: 'tracking', width: 30 },
  { header: 'Pending Follow-ups', key: 'followUpsSummary', width: 32 },
  { header: 'Notes', key: 'notes', width: 26 },
  { header: 'Created At', key: 'created_at', width: 20 }
];

function summarizeFollowUps(followUps) {
  if (!Array.isArray(followUps) || followUps.length === 0) return '';
  return followUps
    .filter(f => f.status === 'pending')
    .map(f => `${f.description}${f.dueDate ? ' (due ' + f.dueDate + ')' : ''}`)
    .join('; ');
}

function csvEscape(val) {
  const s = (val === null || val === undefined) ? '' : String(val);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/orders/export.csv', checkAuth, requireAdmin, async (req, res) => {
  const { text, params } = buildFilterQuery(req.query);
  const result = await pool.query(text, params);
  const headerRow = EXPORT_COLUMNS.map(c => csvEscape(c.header)).join(',');
  const rows = result.rows.map(o => {
    const rowData = { ...o, followUpsSummary: summarizeFollowUps(o.follow_ups), poAttachedLabel: o.has_po_attachment ? 'Yes' : 'No', invoiceAttachedLabel: o.has_invoice_attachment ? 'Yes' : 'No', cashSaleLabel: o.is_cash_sale ? 'Yes' : 'No', paymentSlipAttachedLabel: o.has_payment_slip ? 'Yes' : 'No' };
    return EXPORT_COLUMNS.map(c => csvEscape(c.key === 'created_at' ? new Date(rowData[c.key]).toLocaleString() : rowData[c.key])).join(',');
  });
  const csv = [headerRow, ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/api/orders/export.xlsx', checkAuth, requireAdmin, async (req, res) => {
  const { text, params } = buildFilterQuery(req.query);
  const result = await pool.query(text, params);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Orders');
  sheet.columns = EXPORT_COLUMNS;
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

  result.rows.forEach(o => {
    sheet.addRow({
      id: o.id,
      po_number: o.po_number,
      poAttachedLabel: o.has_po_attachment ? 'Yes' : 'No',
      invoiceAttachedLabel: o.has_invoice_attachment ? 'Yes' : 'No',
      customer: o.customer,
      address: o.address,
      salesperson: o.salesperson,
      items: o.items,
      amount: o.amount,
      status: o.status,
      cashSaleLabel: o.is_cash_sale ? 'Yes' : 'No',
      paymentSlipAttachedLabel: o.has_payment_slip ? 'Yes' : 'No',
      fulfillment: o.fulfillment,
      courier: o.courier,
      tracking: o.tracking,
      followUpsSummary: summarizeFollowUps(o.follow_ups),
      notes: o.notes,
      created_at: new Date(o.created_at).toLocaleString()
    });
  });
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + EXPORT_COLUMNS.length)}1` };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

app.post('/api/orders', checkAuth, async (req, res) => {
  const { salesperson, salespersonEmail, customer, address, amount, items, notes, followUps, poNumber, isCashSale } = req.body || {};
  if (!salesperson || !customer || !items) {
    return res.status(400).json({ error: 'salesperson, customer, and items are required' });
  }
  const id = genId();
  const history = [{ ts: new Date().toISOString(), text: `Order created by ${salesperson}` }];

  const cleanFollowUps = Array.isArray(followUps)
    ? followUps
        .filter(f => f && f.description && f.description.trim())
        .map(f => ({
          id: 'FU-' + Math.random().toString(36).toUpperCase().slice(2, 8),
          description: f.description.trim(),
          dueDate: f.dueDate || null,
          status: 'pending'
        }))
    : [];

  if (cleanFollowUps.length) {
    history.push({ ts: new Date().toISOString(), text: `${cleanFollowUps.length} scheduled follow-up delivery(ies) added` });
  }
  if (isCashSale) {
    history.push({ ts: new Date().toISOString(), text: 'Marked as a cash sale' });
  }

  await pool.query(
    `INSERT INTO orders (id, salesperson, salesperson_email, customer, address, amount, items, notes, history, follow_ups, po_number, is_cash_sale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, salesperson, salespersonEmail || '', customer, address || '', amount || '', items, notes || '', JSON.stringify(history), JSON.stringify(cleanFollowUps), (poNumber || '').trim(), !!isCashSale]
  );
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  res.status(201).json(result.rows[0]);
});

// Only admin can update order status/fulfillment/courier/tracking.
app.patch('/api/orders/:id', checkAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, fulfillment, courier, tracking, poNumber, address } = req.body || {};

  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const history = order.history || [];

  if (status !== undefined && status !== order.status) {
    history.push({ ts: new Date().toISOString(), text: `Payment changed: ${order.status} → ${status}` });
  }
  if (fulfillment !== undefined && fulfillment !== order.fulfillment) {
    history.push({ ts: new Date().toISOString(), text: `Fulfillment changed: ${order.fulfillment} → ${fulfillment}` });
  }
  if (courier !== undefined && courier !== order.courier) {
    history.push({ ts: new Date().toISOString(), text: `Courier set to "${courier}"` });
  }
  if (tracking !== undefined && tracking !== order.tracking) {
    history.push({ ts: new Date().toISOString(), text: `Tracking link set to "${tracking}"` });
  }
  if (poNumber !== undefined && poNumber !== order.po_number) {
    history.push({ ts: new Date().toISOString(), text: `PO number set to "${poNumber}"` });
  }
  if (address !== undefined && address !== order.address) {
    history.push({ ts: new Date().toISOString(), text: `Delivery address updated` });
  }

  await pool.query(
    `UPDATE orders
     SET status = COALESCE($1, status),
         fulfillment = COALESCE($2, fulfillment),
         courier = COALESCE($3, courier),
         tracking = COALESCE($4, tracking),
         po_number = COALESCE($5, po_number),
         address = COALESCE($6, address),
         history = $7
     WHERE id = $8`,
    [status, fulfillment, courier, tracking, poNumber, address, JSON.stringify(history), id]
  );

  // Auto-send: once an order is Shipped with courier + tracking present,
  // email the salesperson automatically — but only once per order, so
  // editing the tracking number later doesn't re-trigger a flood of emails.
  const refreshed = (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  const readyToNotify = refreshed.fulfillment === 'shipped'
    && (refreshed.courier || refreshed.tracking)
    && refreshed.salesperson_email
    && !refreshed.tracking_emailed
    && BREVO_API_KEY && SENDER_EMAIL;

  if (readyToNotify) {
    const text = [
      `Order ${refreshed.id} for ${refreshed.customer}`,
      refreshed.po_number ? `PO: ${refreshed.po_number}` : null,
      `Payment status: ${refreshed.status}`,
      `Fulfillment: ${refreshed.fulfillment}`,
      `Courier: ${refreshed.courier || 'TBC'}`,
      `Tracking Link: ${refreshed.tracking || 'TBC'}`
    ].filter(Boolean).join('\n');
    try {
      await sendMail({ to: refreshed.salesperson_email, subject: `Order ${refreshed.id} — shipped`, text });
      const newHistory = refreshed.history || [];
      newHistory.push({ ts: new Date().toISOString(), text: `Tracking info automatically emailed to ${refreshed.salesperson_email}` });
      await pool.query('UPDATE orders SET tracking_emailed=true, history=$1 WHERE id=$2', [JSON.stringify(newHistory), id]);
    } catch (e) {
      console.error('Auto-email failed for order', id, e.message);
      // Don't fail the status update just because email sending failed —
      // admin can still use the manual "Email to sales" button as a fallback.
    }
  }

  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  res.json(result.rows[0]);
});

// Admin toggles a single follow-up delivery's status (pending <-> fulfilled)
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024; // ~6MB raw file (base64 adds ~33% on top, kept under the 8mb JSON body limit)

// Admin uploads/replaces the PO document attached to an order.
// Body: { fileName, fileType, dataBase64 } — dataBase64 is the raw
// base64 content (no "data:...;base64," prefix — stripped client-side).
app.post('/api/orders/:id/po-attachment', checkAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { fileName, fileType, dataBase64 } = req.body || {};
  if (!fileName || !dataBase64) return res.status(400).json({ error: 'No file provided' });

  const approxBytes = Math.ceil((dataBase64.length * 3) / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    return res.status(400).json({ error: 'File too large — please keep PO attachments under 6MB' });
  }

  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const history = order.history || [];
  history.push({ ts: new Date().toISOString(), text: `PO document attached: ${fileName}` });

  await pool.query(
    'UPDATE orders SET po_file_name=$1, po_file_type=$2, po_file_data=$3, history=$4 WHERE id=$5',
    [fileName, fileType || 'application/octet-stream', dataBase64, JSON.stringify(history), id]
  );
  res.json({ ok: true });
});

// Streams the PO attachment back as a real file download.
app.get('/api/orders/:id/po-attachment', checkAuth, async (req, res) => {
  const result = await pool.query('SELECT po_file_name, po_file_type, po_file_data FROM orders WHERE id=$1', [req.params.id]);
  if (result.rows.length === 0 || !result.rows[0].po_file_data) {
    return res.status(404).json({ error: 'No PO attachment for this order' });
  }
  const { po_file_name, po_file_type, po_file_data } = result.rows[0];
  const buffer = Buffer.from(po_file_data, 'base64');
  res.setHeader('Content-Type', po_file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${po_file_name}"`);
  res.send(buffer);
});

app.delete('/api/orders/:id/po-attachment', checkAuth, requireAdmin, async (req, res) => {
  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const history = order.history || [];
  history.push({ ts: new Date().toISOString(), text: `PO document removed: ${order.po_file_name}` });
  await pool.query(
    `UPDATE orders SET po_file_name='', po_file_type='', po_file_data='', history=$1 WHERE id=$2`,
    [JSON.stringify(history), req.params.id]
  );
  res.json({ ok: true });
});

// Admin uploads/replaces the invoice attached to an order (visible to Sales
// as a download, but only Admin can upload/change/remove it).
app.post('/api/orders/:id/invoice-attachment', checkAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { fileName, fileType, dataBase64 } = req.body || {};
  if (!fileName || !dataBase64) return res.status(400).json({ error: 'No file provided' });

  const approxBytes = Math.ceil((dataBase64.length * 3) / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    return res.status(400).json({ error: 'File too large — please keep invoice attachments under 6MB' });
  }

  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const history = order.history || [];
  history.push({ ts: new Date().toISOString(), text: `Invoice attached: ${fileName}` });

  await pool.query(
    'UPDATE orders SET invoice_file_name=$1, invoice_file_type=$2, invoice_file_data=$3, history=$4 WHERE id=$5',
    [fileName, fileType || 'application/octet-stream', dataBase64, JSON.stringify(history), id]
  );
  res.json({ ok: true });
});

// Any signed-in role (Sales included) can download the invoice.
app.get('/api/orders/:id/invoice-attachment', checkAuth, async (req, res) => {
  const result = await pool.query('SELECT invoice_file_name, invoice_file_type, invoice_file_data FROM orders WHERE id=$1', [req.params.id]);
  if (result.rows.length === 0 || !result.rows[0].invoice_file_data) {
    return res.status(404).json({ error: 'No invoice attached to this order' });
  }
  const { invoice_file_name, invoice_file_type, invoice_file_data } = result.rows[0];
  const buffer = Buffer.from(invoice_file_data, 'base64');
  res.setHeader('Content-Type', invoice_file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice_file_name}"`);
  res.send(buffer);
});

app.delete('/api/orders/:id/invoice-attachment', checkAuth, requireAdmin, async (req, res) => {
  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const history = order.history || [];
  history.push({ ts: new Date().toISOString(), text: `Invoice removed: ${order.invoice_file_name}` });
  await pool.query(
    `UPDATE orders SET invoice_file_name='', invoice_file_type='', invoice_file_data='', history=$1 WHERE id=$2`,
    [JSON.stringify(history), req.params.id]
  );
  res.json({ ok: true });
});

// Payment slip: unlike PO/Invoice attachments, upload is open to ANY
// signed-in role — Sales uploads this at order submission time as proof
// of a cash sale, so it can't be admin-gated the way those others are.
app.post('/api/orders/:id/payment-slip', checkAuth, async (req, res) => {
  const { id } = req.params;
  const { fileName, fileType, dataBase64 } = req.body || {};
  if (!fileName || !dataBase64) return res.status(400).json({ error: 'No file provided' });

  const approxBytes = Math.ceil((dataBase64.length * 3) / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    return res.status(400).json({ error: 'File too large — please keep payment slips under 6MB' });
  }

  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const history = order.history || [];
  history.push({ ts: new Date().toISOString(), text: `Payment slip uploaded: ${fileName}` });

  await pool.query(
    'UPDATE orders SET payment_slip_file_name=$1, payment_slip_file_type=$2, payment_slip_file_data=$3, history=$4 WHERE id=$5',
    [fileName, fileType || 'application/octet-stream', dataBase64, JSON.stringify(history), id]
  );
  res.json({ ok: true });
});

app.get('/api/orders/:id/payment-slip', checkAuth, async (req, res) => {
  const result = await pool.query('SELECT payment_slip_file_name, payment_slip_file_type, payment_slip_file_data FROM orders WHERE id=$1', [req.params.id]);
  if (result.rows.length === 0 || !result.rows[0].payment_slip_file_data) {
    return res.status(404).json({ error: 'No payment slip for this order' });
  }
  const { payment_slip_file_name, payment_slip_file_type, payment_slip_file_data } = result.rows[0];
  const buffer = Buffer.from(payment_slip_file_data, 'base64');
  res.setHeader('Content-Type', payment_slip_file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${payment_slip_file_name}"`);
  res.send(buffer);
});

// Removal stays admin-only — deleting proof of payment is destructive
// enough to warrant the higher permission bar.
app.delete('/api/orders/:id/payment-slip', checkAuth, requireAdmin, async (req, res) => {
  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const history = order.history || [];
  history.push({ ts: new Date().toISOString(), text: `Payment slip removed: ${order.payment_slip_file_name}` });
  await pool.query(
    `UPDATE orders SET payment_slip_file_name='', payment_slip_file_type='', payment_slip_file_data='', history=$1 WHERE id=$2`,
    [JSON.stringify(history), req.params.id]
  );
  res.json({ ok: true });
});

app.patch('/api/orders/:id/followups/:fid', checkAuth, requireAdmin, async (req, res) => {
  const { id, fid } = req.params;
  const { status } = req.body || {};
  if (!['pending', 'fulfilled'].includes(status)) {
    return res.status(400).json({ error: 'status must be "pending" or "fulfilled"' });
  }
  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = existing.rows[0];
  const followUps = order.follow_ups || [];
  const target = followUps.find(f => f.id === fid);
  if (!target) return res.status(404).json({ error: 'Follow-up not found' });

  target.status = status;
  const history = order.history || [];
  history.push({ ts: new Date().toISOString(), text: `Follow-up "${target.description}" marked ${status}` });

  await pool.query('UPDATE orders SET follow_ups=$1, history=$2 WHERE id=$3', [
    JSON.stringify(followUps), JSON.stringify(history), id
  ]);
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  res.json(result.rows[0]);
});

// Admin emails the current tracking/shipment info to the salesperson on file
app.post('/api/orders/:id/email-tracking', checkAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const o = existing.rows[0];

  const text = [
    `Order ${o.id} for ${o.customer}`,
    o.po_number ? `PO: ${o.po_number}` : null,
    `Payment status: ${o.status}`,
    `Fulfillment: ${o.fulfillment}`,
    `Courier: ${o.courier || 'TBC'}`,
    `Tracking Link: ${o.tracking || 'TBC'}`,
    o.notes ? `Notes: ${o.notes}` : null
  ].filter(Boolean).join('\n');

  try {
    await sendMail({ to: o.salesperson_email, subject: `Order ${o.id} — tracking update`, text });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const history = o.history || [];
  history.push({ ts: new Date().toISOString(), text: `Tracking info emailed to ${o.salesperson_email}` });
  await pool.query('UPDATE orders SET history=$1, tracking_emailed=true WHERE id=$2', [JSON.stringify(history), id]);
  res.json({ ok: true });
});

// Admin emails a reminder about a specific scheduled follow-up delivery
app.post('/api/orders/:id/followups/:fid/email-reminder', checkAuth, requireAdmin, async (req, res) => {
  const { id, fid } = req.params;
  const existing = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const o = existing.rows[0];
  const fu = (o.follow_ups || []).find(f => f.id === fid);
  if (!fu) return res.status(404).json({ error: 'Follow-up not found' });

  const text = [
    `Reminder for order ${o.id} — ${o.customer}`,
    `Scheduled delivery: ${fu.description}`,
    fu.dueDate ? `Due date: ${fu.dueDate}` : 'No due date set',
    `Status: ${fu.status}`
  ].join('\n');

  try {
    await sendMail({ to: o.salesperson_email, subject: `Reminder: ${fu.description} — Order ${o.id}`, text });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const history = o.history || [];
  history.push({ ts: new Date().toISOString(), text: `Reminder emailed to ${o.salesperson_email} for "${fu.description}"` });
  await pool.query('UPDATE orders SET history=$1 WHERE id=$2', [JSON.stringify(history), id]);
  res.json({ ok: true });
});

// Any signed-in role can read the catalog (sales needs it to build orders).
app.get('/api/products', checkAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM products ORDER BY name ASC');
  res.json(result.rows);
});

// Admin bulk-imports/upserts the product catalog from a parsed CSV/Excel file.
// Body: { products: [{ name, priceOriginal, priceDoctor, pricePharmacist }] }
// Products are identified by Name (no SKU codes in this business).
app.post('/api/products/import', checkAuth, requireAdmin, async (req, res) => {
  const { products } = req.body || {};
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'No products provided' });
  }

  const clean = products
    .map(p => ({
      name: String(p.name || '').trim(),
      priceOriginal: Number(p.priceOriginal) || 0,
      priceDoctor: Number(p.priceDoctor) || 0,
      pricePharmacist: Number(p.pricePharmacist) || 0
    }))
    .filter(p => p.name);

  if (clean.length === 0) {
    return res.status(400).json({ error: 'No valid rows found — check that each row has a product Name' });
  }

  let upserted = 0;
  for (const p of clean) {
    await pool.query(
      `INSERT INTO products (name, price_original, price_doctor, price_pharmacist, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (name) DO UPDATE SET
         price_original = EXCLUDED.price_original,
         price_doctor = EXCLUDED.price_doctor,
         price_pharmacist = EXCLUDED.price_pharmacist,
         updated_at = now()`,
      [p.name, p.priceOriginal, p.priceDoctor, p.pricePharmacist]
    );
    upserted++;
  }

  res.json({ ok: true, upserted, total: clean.length });
});

app.get('/api/products/export.xlsx', checkAuth, requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM products ORDER BY name ASC');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Product Catalog');
  sheet.columns = [
    { header: 'Name', key: 'name', width: 34 },
    { header: 'Original Price', key: 'price_original', width: 16 },
    { header: 'Doctor Price', key: 'price_doctor', width: 16 },
    { header: 'Pharmacist Price', key: 'price_pharmacist', width: 16 },
    { header: 'Last Updated', key: 'updated_at', width: 20 }
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

  result.rows.forEach(p => {
    sheet.addRow({
      name: p.name,
      price_original: Number(p.price_original),
      price_doctor: Number(p.price_doctor),
      price_pharmacist: Number(p.price_pharmacist),
      updated_at: new Date(p.updated_at).toLocaleString()
    });
  });
  ['B', 'C', 'D'].forEach(col => {
    sheet.getColumn(col).numFmt = '"RM"#,##0.00';
  });
  sheet.autoFilter = { from: 'A1', to: 'E1' };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="product-catalog-${Date.now()}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

app.delete('/api/products/:name', checkAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE name=$1', [req.params.name]);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Order Desk running on port ${PORT}`)))
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

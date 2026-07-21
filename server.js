require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const { pool, init } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SALES_PASSWORD = process.env.SALES_PASSWORD || 'sales123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// --- Email setup ---
// Works with any SMTP provider: your company's Office 365/Google Workspace
// SMTP relay, or a transactional service like SendGrid/Mailgun.
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log('Email sending enabled via', process.env.SMTP_HOST);
} else {
  console.log('Email sending disabled: SMTP_HOST/SMTP_USER/SMTP_PASS not set.');
}

async function sendMail({ to, subject, text }) {
  if (!mailer) throw new Error('Email is not configured on this server yet.');
  if (!to) throw new Error('This order has no salesperson email on file.');
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text
  });
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
  const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
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
  return { text: `SELECT * FROM orders ${where} ORDER BY created_at DESC`, params };
}

const EXPORT_COLUMNS = [
  { header: 'Order ID', key: 'id', width: 16 },
  { header: 'Customer', key: 'customer', width: 24 },
  { header: 'Salesperson', key: 'salesperson', width: 18 },
  { header: 'Items', key: 'items', width: 34 },
  { header: 'Amount (RM)', key: 'amount', width: 14 },
  { header: 'Payment Status', key: 'status', width: 16 },
  { header: 'Fulfillment', key: 'fulfillment', width: 14 },
  { header: 'Courier', key: 'courier', width: 16 },
  { header: 'Tracking / AWB', key: 'tracking', width: 20 },
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
    const rowData = { ...o, followUpsSummary: summarizeFollowUps(o.follow_ups) };
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
      customer: o.customer,
      salesperson: o.salesperson,
      items: o.items,
      amount: o.amount,
      status: o.status,
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
  const { salesperson, salespersonEmail, customer, amount, items, notes, followUps } = req.body || {};
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

  await pool.query(
    `INSERT INTO orders (id, salesperson, salesperson_email, customer, amount, items, notes, history, follow_ups)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, salesperson, salespersonEmail || '', customer, amount || '', items, notes || '', JSON.stringify(history), JSON.stringify(cleanFollowUps)]
  );
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  res.status(201).json(result.rows[0]);
});

// Only admin can update order status/fulfillment/courier/tracking.
app.patch('/api/orders/:id', checkAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, fulfillment, courier, tracking } = req.body || {};

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
    history.push({ ts: new Date().toISOString(), text: `Tracking number set to "${tracking}"` });
  }

  await pool.query(
    `UPDATE orders
     SET status = COALESCE($1, status),
         fulfillment = COALESCE($2, fulfillment),
         courier = COALESCE($3, courier),
         tracking = COALESCE($4, tracking),
         history = $5
     WHERE id = $6`,
    [status, fulfillment, courier, tracking, JSON.stringify(history), id]
  );
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  res.json(result.rows[0]);
});

// Admin toggles a single follow-up delivery's status (pending <-> fulfilled)
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
    `Payment status: ${o.status}`,
    `Fulfillment: ${o.fulfillment}`,
    `Courier: ${o.courier || 'TBC'}`,
    `Tracking / AWB: ${o.tracking || 'TBC'}`,
    o.notes ? `Notes: ${o.notes}` : null
  ].filter(Boolean).join('\n');

  try {
    await sendMail({ to: o.salesperson_email, subject: `Order ${o.id} — tracking update`, text });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const history = o.history || [];
  history.push({ ts: new Date().toISOString(), text: `Tracking info emailed to ${o.salesperson_email}` });
  await pool.query('UPDATE orders SET history=$1 WHERE id=$2', [JSON.stringify(history), id]);
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Order Desk running on port ${PORT}`)))
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

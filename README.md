# Order Desk

Order intake and fulfillment tracker: salespeople submit orders, admin
processes them through Payment status (Pending → Processing → Paid) and
Fulfillment status (Not Packed → Packed → Shipped), with courier/tracking
capture, a full change history per order, and a one-click "copy shipment
info" for sharing tracking numbers with customers.

## Stack
- Backend: Node.js + Express
- Database: PostgreSQL
- Frontend: plain HTML/CSS/JS (no build step), served by Express

## 1. Local setup (optional, to test before deploying)

```bash
npm install
cp .env.example .env
# edit .env: point DATABASE_URL at a local Postgres, set your own passwords
npm start
```

Visit `http://localhost:3000`. Log in with the Sales or Admin password
you set in `.env`.

If you don't want to install Postgres locally, skip straight to Railway —
it gives you a database in one click.

## 2. Deploy to Railway

1. **Push this folder to a GitHub repo.**
   ```bash
   git init
   git add .
   git commit -m "Order Desk initial commit"
   git branch -M main
   git remote add origin <your-empty-github-repo-url>
   git push -u origin main
   ```

2. **Create a Railway project.**
   Go to [railway.app](https://railway.app) → sign in with GitHub →
   "New Project" → "Deploy from GitHub repo" → select this repo.

3. **Add a PostgreSQL database.**
   In the same Railway project: "New" → "Database" → "Add PostgreSQL".
   Railway automatically creates a `DATABASE_URL` variable and makes it
   available to your app — you don't need to copy/paste anything.

4. **Set your passwords.**
   Go to your app service → "Variables" tab → add:
   - `SALES_PASSWORD` — password salespeople use to log in
   - `ADMIN_PASSWORD` — password you (admin) use to log in

   Do NOT reuse the `.env` file's example passwords in production.

5. **Deploy.**
   Railway builds and starts the app automatically. Once it's live,
   click "Generate Domain" under Settings to get a public URL like
   `order-desk-production.up.railway.app`.

6. **Every future update:** just `git push` — Railway redeploys
   automatically.

## 3. Point your own domain (optional)

In Railway: Settings → Networking → Custom Domain → add e.g.
`orders.yourcompany.com`, then add the CNAME record Railway gives you
to your domain's DNS settings.

## Notes on the auth model

This uses one shared password per role (Sales / Admin) — simple and
fine for a small trusted team. If you want individual logins per
staff member (so you know exactly *who* changed a status, not just
"someone with the sales password"), that's a natural next upgrade:
add a `users` table with per-person accounts and swap the shared
password check for a real login lookup.

## API reference

| Method | Path            | Auth        | Purpose                          |
|--------|-----------------|-------------|-----------------------------------|
| POST   | /api/login      | —           | Exchange role+password for a token |
| GET    | /api/orders     | any role    | List all orders                   |
| POST   | /api/orders     | any role    | Submit a new order                |
| PATCH  | /api/orders/:id | admin only  | Update status/fulfillment/courier/tracking |
| PATCH  | /api/orders/:id/followups/:fid | admin only | Mark a scheduled follow-up delivery pending/fulfilled |
| POST   | /api/orders/:id/po-attachment | admin only | Upload/replace the PO document attached to an order |
| GET    | /api/orders/:id/po-attachment | any role | Download the attached PO document |
| DELETE | /api/orders/:id/po-attachment | admin only | Remove the attached PO document |
| POST   | /api/orders/:id/email-tracking | admin only | Email current tracking/shipment info to the salesperson on file |
| POST   | /api/orders/:id/followups/:fid/email-reminder | admin only | Email a reminder about a scheduled follow-up to the salesperson |
| GET    | /api/products | any role | List the SKU catalog |
| POST   | /api/products/import | admin only | Bulk upload/update products from a parsed CSV or Excel file |
| DELETE | /api/products/:sku | admin only | Remove a single SKU from the catalog |
| GET    | /api/orders/export.csv  | admin only | Download orders as CSV. Optional query params: `status`, `fulfillment`, `from`, `to` |
| GET    | /api/orders/export.xlsx | admin only | Download orders as a formatted Excel file. Same optional query params |

## SKU catalog & tiered pricing

Admin has a **Products** tab (visible only to Admin) for managing your SKU catalog:

- **Upload a CSV or Excel file** with columns: `SKU`, `Name`, `Original Price`, `Doctor Price`, `Pharmacist Price` (header names are matched flexibly — e.g. "Doctor's Price" or "DR Price" both work).
- Uploading is an **upsert**: existing SKUs get updated, new ones get added. Nothing is deleted unless you remove it individually.
- A preview table shows what will be imported before you confirm.

**On the Sales side**, the order form now has:
- A **Customer Type** selector (Original / Doctor / Pharmacist) — this determines which price tier is used
- A **SKU picker** with autocomplete against the catalog — search by SKU or product name, set quantity, click Add
- Each added item shows its price for the selected tier automatically; changing Customer Type recalculates all added items
- The traditional "Items summary" and "Order Amount" fields are auto-filled from what's picked, but remain editable by hand for one-off items not yet in the catalog



## Email notifications

Admin can send two kinds of email straight from the Admin Desk, using
your company's own email address as the sender:

- **"Email to sales"** — appears once an order is marked Shipped with
  courier/tracking filled in. Sends the salesperson the tracking info.
- **"Send reminder"** — appears next to each pending scheduled
  delivery. Sends the salesperson a reminder of what's due and when.

Both require the salesperson to have entered their email when
submitting the order (a field on the Sales tab). If it's missing,
the buttons won't appear for that order.

### Setting up email sending

Email is **off by default** until configured. This app sends via
**Brevo's HTTPS API**, not SMTP — Railway blocks outbound SMTP ports
(25/465/587) on Free/Trial/Hobby plans, but never blocks standard
HTTPS traffic, so this works on any Railway plan without upgrading.

Add these variables in Railway (Variables tab) or your local `.env`:

| Variable | Purpose |
|---|---|
| `BREVO_API_KEY` | API key from Brevo (not the SMTP key — see below) |
| `SENDER_EMAIL` | The verified sender address, e.g. `orders@yourcompany.com` |
| `SENDER_NAME` | Display name recipients see, e.g. `Order Desk` |

**Setup steps:**
1. Sign up free at [brevo.com](https://www.brevo.com) (free tier: 300 emails/day)
2. Verify your sending domain: **Senders, Domains & Dedicated IPs** → **Domains** → add your domain → add the DNS records Brevo gives you at your domain registrar → click Verify (DNS changes can take minutes to hours to propagate)
3. Add a sender on that verified domain: **Senders, Domains & Dedicated IPs** → **Senders** → add e.g. `orders@yourcompany.com`
4. Generate an API key: account menu → **Settings** → **SMTP & API** → **API Keys** → **Generate a new API key**. Leave **"Create MCP server API key" unchecked** — that's an unrelated key type for connecting AI assistants to Brevo, not for sending app emails.
5. Copy the key (starts with `xkeysib-...`) into `BREVO_API_KEY`

Once set in Railway, redeploy — the server logs
`Email sending enabled via Brevo API, sender: ...` on startup once
it detects valid credentials.

**Note:** using a free Gmail/Outlook address as `SENDER_EMAIL` instead
of a verified domain will trigger Brevo's "Not Compliant" warning and
hurt deliverability (may land in spam). Verifying your own domain, as
in step 2, avoids this.

## Split / scheduled deliveries

For customers who buy stock in bulk but want it released in batches
(e.g. "6 months of stock, deliver 3 months now and 3 months later"):

- When submitting an order, sales can check **"This order has a split
  delivery schedule"** and add one or more follow-up entries, each with
  a description (e.g. "Second 3-month batch") and an optional due date.
- These show up on the order card in Admin Desk under **Scheduled
  deliveries**, with an overdue warning if the due date has passed.
- Admin clicks **Mark done** when a batch goes out, which is logged to
  the order's history.
- The **Follow-ups Due** filter button shows only orders with at least
  one pending scheduled delivery — useful as a daily "what do I need to
  prepare next" check.
- Pending follow-ups also appear in the CSV/Excel export as a
  "Pending Follow-ups" column, so you can report on what's still owed
  to customers.

## Purchase Orders (PO)

For customers who order against a PO:

- Sales can optionally enter a **PO Number** when submitting an order
- Admin can also add/edit the PO Number later directly on the order card, and it's shown next to the Order ID once set
- Admin can **attach the actual PO document** (PDF or image, up to 6MB) to any order — click the file picker on the order card. Once attached, the card shows the filename with **Download** and **Remove** buttons instead of the upload field
- The PO Number and whether a document is attached both appear in the CSV/Excel exports

## Report exports

The Admin Desk has an export bar at the top with a date range and two
buttons: **Export CSV** and **Export Excel**. Both respect whatever
filter is currently active (e.g. "Payment: Paid" or "Shipped"), so you
can pull something like "all Paid orders shipped in June" in two clicks.

- **CSV** — universal, opens in Excel/Sheets/Numbers, good for quick pulls or feeding into other tools.
- **Excel (.xlsx)** — proper formatted spreadsheet with bold headers and auto-filter dropdowns already turned on, ready to hand to an accountant or manager.

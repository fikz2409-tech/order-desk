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

Email is **off by default** until you configure SMTP credentials.
Add these variables in Railway (Variables tab) or your local `.env`:

| Variable | Purpose |
|---|---|
| `SMTP_HOST` | Your mail server, e.g. `smtp.gmail.com` or `smtp.office365.com` |
| `SMTP_PORT` | Usually `587` |
| `SMTP_SECURE` | `false` for port 587 (STARTTLS), `true` for port 465 |
| `SMTP_USER` | Your company email address |
| `SMTP_PASS` | App password (see below) — not your normal login password |
| `SMTP_FROM` | The "from" address shown to recipients (usually same as `SMTP_USER`) |

**Google Workspace / Gmail:** you need an "App Password," not your
regular password. Generate one at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
(requires 2-Step Verification to be turned on first).

**Microsoft 365 / Outlook:** use `smtp.office365.com`, port `587`. If
your organization enforces modern auth / MFA, you may similarly need
an app password from your Microsoft 365 admin settings rather than
your normal password.

Once these are set in Railway, redeploy (or it will pick them up on
the next deploy) — the server logs `Email sending enabled via ...`
on startup once it detects valid SMTP settings.

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

## Report exports

The Admin Desk has an export bar at the top with a date range and two
buttons: **Export CSV** and **Export Excel**. Both respect whatever
filter is currently active (e.g. "Payment: Paid" or "Shipped"), so you
can pull something like "all Paid orders shipped in June" in two clicks.

- **CSV** — universal, opens in Excel/Sheets/Numbers, good for quick pulls or feeding into other tools.
- **Excel (.xlsx)** — proper formatted spreadsheet with bold headers and auto-filter dropdowns already turned on, ready to hand to an accountant or manager.

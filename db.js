const { Pool } = require('pg');

// Railway (and most managed Postgres hosts) require SSL but use a
// self-signed cert chain, so we disable strict verification.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      salesperson TEXT NOT NULL,
      customer TEXT NOT NULL,
      amount TEXT DEFAULT '',
      items TEXT NOT NULL,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      fulfillment TEXT DEFAULT 'notpacked',
      courier TEXT DEFAULT '',
      tracking TEXT DEFAULT '',
      history JSONB DEFAULT '[]',
      follow_ups JSONB DEFAULT '[]',
      salesperson_email TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Safe to run every startup: adds columns if this table pre-dates them.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS follow_ups JSONB DEFAULT '[]';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS salesperson_email TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_emailed BOOLEAN DEFAULT false;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      price_original NUMERIC DEFAULT 0,
      price_doctor NUMERIC DEFAULT 0,
      price_pharmacist NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('Database ready.');
}

module.exports = { pool, init };

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
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Safe to run every startup: adds the column if this table pre-dates it.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS follow_ups JSONB DEFAULT '[]';`);
  console.log('Database ready.');
}

module.exports = { pool, init };

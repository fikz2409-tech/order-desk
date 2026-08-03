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
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS po_number TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS po_file_name TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS po_file_type TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS po_file_data TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_file_name TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_file_type TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_file_data TEXT DEFAULT '';`);

  // Products table: identified by Name, not SKU (no formal SKU codes in
  // this business — items are just named products with three price tiers).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      name TEXT PRIMARY KEY,
      price_original NUMERIC DEFAULT 0,
      price_doctor NUMERIC DEFAULT 0,
      price_pharmacist NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // One-time migration: if an older SKU-keyed products table exists
  // (from before this change), migrate its data into the new Name-keyed
  // schema, then drop the old one. Safe to run every startup — it only
  // acts if the old 'sku' column is still present.
  const skuColCheck = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='products' AND column_name='sku'`
  );
  if (skuColCheck.rows.length > 0) {
    await pool.query(`ALTER TABLE products RENAME TO products_old_sku;`);
    await pool.query(`
      CREATE TABLE products (
        name TEXT PRIMARY KEY,
        price_original NUMERIC DEFAULT 0,
        price_doctor NUMERIC DEFAULT 0,
        price_pharmacist NUMERIC DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`
      INSERT INTO products (name, price_original, price_doctor, price_pharmacist, updated_at)
      SELECT DISTINCT ON (name) name, price_original, price_doctor, price_pharmacist, updated_at
      FROM products_old_sku
      WHERE name IS NOT NULL AND name != ''
      ORDER BY name, updated_at DESC
      ON CONFLICT (name) DO NOTHING;
    `);
    await pool.query(`DROP TABLE products_old_sku;`);
    console.log('Migrated products table from SKU-keyed to Name-keyed schema.');
  }

  console.log('Database ready.');
}

module.exports = { pool, init };

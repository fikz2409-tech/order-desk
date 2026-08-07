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
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_cash_sale BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_slip_file_name TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_slip_file_type TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_slip_file_data TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bonus_tier TEXT DEFAULT '';`);

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

  // Bonus scheme: a fixed set of "buy X get Y free" tiers, global (not
  // tied to any specific product). Admin can edit the remarks per tier
  // (e.g. custom pricing notes) but the tiers themselves are fixed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bonus_tiers (
      label TEXT PRIMARY KEY,
      buy_qty INTEGER NOT NULL,
      free_qty INTEGER NOT NULL,
      remarks TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );
  `);
  const bonusCountRes = await pool.query('SELECT COUNT(*) FROM bonus_tiers');
  if (parseInt(bonusCountRes.rows[0].count, 10) === 0) {
    const fixedTiers = [
      ['6+1', 6, 1, 1],
      ['15+3', 15, 3, 2],
      ['30+10', 30, 10, 3],
      ['60+25', 60, 25, 4],
      ['120+60', 120, 60, 5],
      ['240+150', 240, 150, 6]
    ];
    for (const [label, buyQty, freeQty, sortOrder] of fixedTiers) {
      await pool.query(
        'INSERT INTO bonus_tiers (label, buy_qty, free_qty, sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT (label) DO NOTHING',
        [label, buyQty, freeQty, sortOrder]
      );
    }
    console.log('Seeded bonus_tiers with default tiers.');
  }

  console.log('Database ready.');
}

module.exports = { pool, init };

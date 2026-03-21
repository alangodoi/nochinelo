const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'price-tracker.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT,
      url TEXT NOT NULL,
      current_price REAL,
      target_price REAL,
      alert_triggered INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      unavailable INTEGER DEFAULT 0,
      added_at TEXT NOT NULL,
      last_checked TEXT,
      tracked INTEGER DEFAULT 1,
      image_url TEXT,
      coupon TEXT
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      price REAL,
      event TEXT,
      old_product_id TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Migrations for existing DBs
  const columns = db.prepare("PRAGMA table_info(products)").all();
  const colNames = columns.map(c => c.name);
  if (!colNames.includes('tracked')) {
    db.exec('ALTER TABLE products ADD COLUMN tracked INTEGER DEFAULT 1');
  }
  if (!colNames.includes('image_url')) {
    db.exec('ALTER TABLE products ADD COLUMN image_url TEXT');
  }
  if (!colNames.includes('coupon')) {
    db.exec('ALTER TABLE products ADD COLUMN coupon TEXT');
  }

  // Seed default settings
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insert.run('checkIntervalMinutes', '1440');
  insert.run('maxHistoryPerProduct', '1000');
}

module.exports = { getDb };

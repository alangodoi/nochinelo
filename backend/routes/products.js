const express = require('express');
const { getDb } = require('../db');
const { detectFromUrl, getScraper } = require('../scrapers');
const { checkProduct } = require('../scheduler');
const { searchByEAN } = require('../utils/store-search');

const router = express.Router();

// Helpers to convert DB rows to API format
function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    url: row.url,
    currentPrice: row.current_price,
    targetPrice: row.target_price,
    alertTriggered: !!row.alert_triggered,
    failCount: row.fail_count,
    unavailable: !!row.unavailable,
    addedAt: row.added_at,
    lastChecked: row.last_checked,
    tracked: !!row.tracked,
    imageUrl: row.image_url,
    coupon: row.coupon || null,
    ean: row.ean || null
  };
}

// GET /api/products
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM products WHERE tracked = 1 ORDER BY added_at DESC').all();
  res.json(rows.map(toApi));
});

// GET /api/products/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Product not found' });
  res.json(toApi(row));
});

// POST /api/products
router.post('/', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const detected = detectFromUrl(url);
  if (!detected) return res.status(400).json({ error: 'Unsupported URL' });

  const { source, productId, scraper } = detected;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);

  if (existing) {
    // Product already in DB — just re-activate tracking
    if (!existing.tracked) {
      db.prepare('UPDATE products SET tracked = 1, url = ? WHERE id = ?').run(url, productId);
    }
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    return res.json(toApi(row));
  }

  // New product — scrape immediately
  let price = null;
  let title = null;
  let imageUrl = null;
  let coupon = null;
  try {
    const result = await scraper.scrape(url);
    if (result) {
      price = result.price;
      title = result.title;
      imageUrl = result.imageUrl || null;
      coupon = result.coupon || null;
    }
  } catch (e) {
    console.error(`Scrape failed for ${url}:`, e.message);
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO products (id, source, title, url, current_price, added_at, last_checked, tracked, image_url, coupon)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(productId, source, title, url, price, now, now, imageUrl, coupon);

  // Record initial price
  if (price) {
    db.prepare(
      'INSERT INTO price_history (product_id, ts, price) VALUES (?, ?, ?)'
    ).run(productId, Date.now(), price);
  }

  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const product = toApi(row);

  // Check if the same product (by EAN) exists in other stores with a lower price
  if (row.ean) {
    const alternatives = db.prepare(
      'SELECT * FROM products WHERE ean = ? AND id != ? AND source != ? AND current_price IS NOT NULL AND tracked = 1 ORDER BY current_price ASC'
    ).all(row.ean, productId, source);

    if (alternatives.length > 0 && alternatives[0].current_price < (row.current_price || Infinity)) {
      product.cheaperAlternative = toApi(alternatives[0]);
    }
  }

  res.status(201).json(product);
});

// DELETE /api/products/:id — stops tracking but keeps the product and history
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  db.prepare('UPDATE products SET tracked = 0, target_price = NULL, alert_triggered = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// PATCH /api/products/:id
router.patch('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  const updates = [];
  const values = [];

  if (req.body.targetPrice !== undefined) {
    updates.push('target_price = ?');
    values.push(req.body.targetPrice);
    // Reset alert when target changes
    updates.push('alert_triggered = 0');
  }
  if (req.body.url !== undefined) {
    updates.push('url = ?');
    values.push(req.body.url);
  }
  if (req.body.title !== undefined) {
    updates.push('title = ?');
    values.push(req.body.title);
  }
  if (req.body.ean !== undefined) {
    updates.push('ean = ?');
    values.push(req.body.ean);
  }

  if (updates.length === 0) return res.json(toApi(existing));

  values.push(req.params.id);
  db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(toApi(row));
});

// POST /api/products/:id/replace
router.post('/:id/replace', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const detected = detectFromUrl(url);
  if (!detected) return res.status(400).json({ error: 'Unsupported URL' });

  const db = getDb();
  const oldProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!oldProduct) return res.status(404).json({ error: 'Product not found' });

  const { source, productId: newId } = detected;

  if (newId === req.params.id) {
    return res.status(400).json({ error: 'Same product' });
  }

  const existingNew = db.prepare('SELECT * FROM products WHERE id = ?').get(newId);
  if (existingNew) {
    return res.status(409).json({ error: 'New product already tracked' });
  }

  // Add replacement marker to history
  db.prepare(
    'INSERT INTO price_history (product_id, ts, price, event, old_product_id) VALUES (?, ?, NULL, ?, ?)'
  ).run(req.params.id, Date.now(), 'replaced', req.params.id);

  // Migrate: update product ID, move history
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO products (id, source, title, url, current_price, target_price, alert_triggered, fail_count, unavailable, added_at, last_checked)
    VALUES (?, ?, ?, ?, NULL, ?, 0, 0, 0, ?, ?)
  `).run(newId, source, oldProduct.title, url, oldProduct.target_price, oldProduct.added_at, now);

  // Move price history from old to new
  db.prepare('UPDATE price_history SET product_id = ? WHERE product_id = ?').run(newId, req.params.id);

  // Delete old product
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);

  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(newId);
  res.json(toApi(row));
});

// POST /api/products/:id/price — receive price update from extension content script
router.post('/:id/price', (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { price, title, imageUrl, ean } = req.body;
  if (!price || typeof price !== 'number') return res.status(400).json({ error: 'Valid price is required' });

  const now = new Date().toISOString();

  // Update product info
  db.prepare(`
    UPDATE products SET
      current_price = ?,
      title = COALESCE(?, title),
      image_url = COALESCE(?, image_url),
      ean = COALESCE(?, ean),
      fail_count = 0,
      unavailable = 0,
      last_checked = ?
    WHERE id = ?
  `).run(price, title || null, imageUrl || null, ean || null, now, req.params.id);

  // Alert logic
  if (product.target_price && price <= product.target_price && !product.alert_triggered) {
    db.prepare('UPDATE products SET alert_triggered = 1 WHERE id = ?').run(req.params.id);
  }
  if (product.target_price && price > product.target_price && product.alert_triggered) {
    db.prepare('UPDATE products SET alert_triggered = 0 WHERE id = ?').run(req.params.id);
  }

  // Record price history (with dedup)
  const lastEntry = db.prepare(
    'SELECT ts, price FROM price_history WHERE product_id = ? ORDER BY ts DESC LIMIT 1'
  ).get(req.params.id);

  const sixHoursMs = 6 * 60 * 60 * 1000;
  const shouldRecord = !lastEntry
    || lastEntry.price !== price
    || (Date.now() - lastEntry.ts) >= sixHoursMs;

  if (shouldRecord) {
    db.prepare(
      'INSERT INTO price_history (product_id, ts, price) VALUES (?, ?, ?)'
    ).run(req.params.id, Date.now(), price);
  }

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(toApi(updated));
});

// POST /api/products/:id/check
router.post('/:id/check', async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  await checkProduct(product);

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(toApi(updated));
});

// GET /api/products/:id/suggestions
router.get('/:id/suggestions', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM suggestions WHERE product_id = ? ORDER BY price ASC'
  ).all(req.params.id);
  res.json(rows);
});

// POST /api/products/:id/suggestions/refresh — trigger a new search
router.post('/:id/suggestions/refresh', async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!product.ean) return res.status(400).json({ error: 'Product has no EAN — visit the product page to extract it' });

  try {
    const results = await searchByEAN(product.ean, product.source);
    db.prepare('DELETE FROM suggestions WHERE product_id = ?').run(req.params.id);

    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO suggestions (product_id, url, title, source, price, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of results) {
      insert.run(req.params.id, r.url, r.title, r.source, r.price || null, r.imageUrl || null, now);
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;

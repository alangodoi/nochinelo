const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/products/:id/history
router.get('/:id/history', (req, res) => {
  const db = getDb();

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const rows = db.prepare(
    'SELECT ts, price, event, old_product_id FROM price_history WHERE product_id = ? ORDER BY ts ASC'
  ).all(req.params.id);

  res.json(rows.map(r => ({
    ts: r.ts,
    price: r.price,
    event: r.event || undefined,
    oldProductId: r.old_product_id || undefined
  })));
});

module.exports = router;

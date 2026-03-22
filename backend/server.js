const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./db');
const productsRouter = require('./routes/products');
const pricesRouter = require('./routes/prices');
const scheduler = require('./scheduler');
const { closeBrowser } = require('./utils/browser');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — only allow the Chrome/Firefox extension origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (e.g. curl, server-to-server) only in dev
    if (!origin) {
      return callback(null, process.env.NODE_ENV !== 'production');
    }
    // Allow chrome-extension:// and moz-extension:// origins
    if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
      return callback(null, true);
    }
    // Allow explicitly configured origins
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  }
}));

// Rate limiting — 100 requests per minute per IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later.' }
}));

// API key authentication
const API_KEY = process.env.API_KEY || 'dev-key-change-me';

app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
});

app.use(express.json());

// Routes
app.use('/api/products', productsRouter);
app.use('/api/products', pricesRouter);

// Settings endpoints
app.get('/api/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = isNaN(row.value) ? row.value : Number(row.value);
  }
  res.json(settings);
});

app.patch('/api/settings', (req, res) => {
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  for (const [key, value] of Object.entries(req.body)) {
    upsert.run(key, String(value));
  }

  // Restart scheduler if interval changed
  if (req.body.checkIntervalMinutes !== undefined) {
    scheduler.restart();
  }

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = isNaN(row.value) ? row.value : Number(row.value);
  }
  res.json(settings);
});

// Alerts polling endpoint (for the extension to check for new alerts)
app.get('/api/alerts', (req, res) => {
  const db = getDb();
  const alerts = db.prepare(
    'SELECT * FROM products WHERE alert_triggered = 1'
  ).all();

  const unavailable = db.prepare(
    'SELECT * FROM products WHERE unavailable = 1'
  ).all();

  res.json({
    priceAlerts: alerts.map(a => ({
      id: a.id,
      title: a.title,
      currentPrice: a.current_price,
      targetPrice: a.target_price
    })),
    unavailableAlerts: unavailable.map(u => ({
      id: u.id,
      title: u.title
    }))
  });
});

// Initialize DB and start
getDb();
console.log('[DB] SQLite initialized');

app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
  scheduler.start();
});

// Graceful shutdown — close headless browser
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await closeBrowser();
    process.exit(0);
  });
}

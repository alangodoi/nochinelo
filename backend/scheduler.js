const cron = require('node-cron');
const { getDb } = require('./db');
const { getScraper } = require('./scrapers');
const { searchByEAN } = require('./utils/store-search');

let cronTask = null;

function shouldRecordPrice(lastEntry, newPrice) {
  if (!lastEntry) return true;
  const priceChanged = lastEntry.price !== newPrice;
  const sixHoursMs = 6 * 60 * 60 * 1000;
  const enoughTimeElapsed = (Date.now() - lastEntry.ts) >= sixHoursMs;
  return priceChanged || enoughTimeElapsed;
}

async function checkProduct(product) {
  if (SKIP_SOURCES.has(product.source)) return;
  const scraper = getScraper(product.source);
  if (!scraper) return;

  const url = scraper.buildUrl(product.id);
  try {
    const result = await scraper.scrape(url);
    const db = getDb();

    if (result?.price) {
      // Reset fail count on success
      const updateStmt = db.prepare(`
        UPDATE products SET
          current_price = ?,
          title = COALESCE(?, title),
          image_url = COALESCE(?, image_url),
          coupon = ?,
          fail_count = 0,
          unavailable = 0,
          last_checked = ?
        WHERE id = ?
      `);
      const now = new Date().toISOString();
      updateStmt.run(result.price, result.title, result.imageUrl || null, result.coupon || null, now, product.id);

      // Check alert
      if (product.target_price && result.price <= product.target_price && !product.alert_triggered) {
        db.prepare('UPDATE products SET alert_triggered = 1 WHERE id = ?').run(product.id);
        console.log(`[ALERT] ${product.title}: R$${result.price.toFixed(2)} <= target R$${product.target_price.toFixed(2)}`);
      }
      if (product.target_price && result.price > product.target_price && product.alert_triggered) {
        db.prepare('UPDATE products SET alert_triggered = 0 WHERE id = ?').run(product.id);
      }

      // Record price history (with dedup)
      const lastEntry = db.prepare(
        'SELECT ts, price FROM price_history WHERE product_id = ? ORDER BY ts DESC LIMIT 1'
      ).get(product.id);

      if (shouldRecordPrice(lastEntry, result.price)) {
        db.prepare(
          'INSERT INTO price_history (product_id, ts, price) VALUES (?, ?, ?)'
        ).run(product.id, Date.now(), result.price);
      }

      console.log(`[CHECK] ${product.id} (${product.source}): R$${result.price.toFixed(2)}`);
    } else {
      // Track failure
      const failCount = (product.fail_count || 0) + 1;
      const unavailable = failCount >= 3 ? 1 : 0;

      db.prepare(`
        UPDATE products SET fail_count = ?, unavailable = ?, last_checked = ? WHERE id = ?
      `).run(failCount, unavailable, new Date().toISOString(), product.id);

      if (unavailable && !product.unavailable) {
        console.log(`[UNAVAIL] ${product.title} marked unavailable after ${failCount} failures`);

        // Search for alternatives by EAN (fire-and-forget)
        if (product.ean) {
          searchByEAN(product.ean, product.source).then(results => {
            if (results.length === 0) return;
            const db = getDb();
            const now = new Date().toISOString();
            db.prepare('DELETE FROM suggestions WHERE product_id = ?').run(product.id);
            const insert = db.prepare(
              'INSERT INTO suggestions (product_id, url, title, source, price, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            for (const r of results) {
              insert.run(product.id, r.url, r.title, r.source, r.price || null, r.imageUrl || null, now);
            }
            console.log(`[SEARCH] Found ${results.length} alternatives for ${product.title}`);
          }).catch(e => {
            console.error(`[SEARCH] Error finding alternatives:`, e.message);
          });
        }
      }

      console.log(`[FAIL] ${product.id} (${product.source}): attempt ${failCount}`);
    }
  } catch (e) {
    console.error(`[ERROR] checking ${product.id}:`, e.message);
  }
}

const SKIP_SOURCES = new Set([]);

async function checkAllProducts() {
  const db = getDb();
  const products = db.prepare(
    'SELECT * FROM products WHERE unavailable = 0'
  ).all().filter(p => !SKIP_SOURCES.has(p.source));

  if (products.length === 0) return;

  console.log(`[SCHEDULER] Checking ${products.length} products...`);

  for (let i = 0; i < products.length; i++) {
    await checkProduct(products[i]);

    // Rate limiting: 3s delay between requests
    if (i < products.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log('[SCHEDULER] Done.');
}

function start() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'checkIntervalMinutes'").get();
  const intervalMinutes = row ? parseInt(row.value, 10) : 1440;

  // Convert minutes to cron expression
  // For intervals <= 59 min, use */N * * * *
  // For intervals >= 60 min, use every N hours
  let cronExpr;
  if (intervalMinutes <= 59) {
    cronExpr = `*/${intervalMinutes} * * * *`;
  } else {
    const hours = Math.max(1, Math.round(intervalMinutes / 60));
    cronExpr = `0 */${hours} * * *`;
  }

  if (cronTask) cronTask.stop();

  cronTask = cron.schedule(cronExpr, () => {
    checkAllProducts();
  });

  console.log(`[SCHEDULER] Running every ${intervalMinutes} minutes (cron: ${cronExpr})`);

  // Run initial check after 30s
  setTimeout(() => checkAllProducts(), 30000);
}

function restart() {
  start();
}

module.exports = { start, restart, checkAllProducts, checkProduct };

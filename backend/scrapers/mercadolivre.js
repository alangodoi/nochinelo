const { getPage, releasePage } = require('../utils/browser');

async function scrape(url) {
  const page = await getPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('.andes-money-amount__fraction', { timeout: 10000 }).catch(() => {});

    const result = await page.evaluate(() => {
      let price = null;

      // Find the first .andes-money-amount that contains a currency symbol (the main price)
      const amounts = document.querySelectorAll('.andes-money-amount');
      for (const el of amounts) {
        const currency = el.querySelector('.andes-money-amount__currency-symbol');
        if (!currency) continue;
        const fractionEl = el.querySelector('.andes-money-amount__fraction');
        if (!fractionEl) continue;
        const fraction = fractionEl.textContent.replace(/\./g, '');
        const centsEl = el.querySelector('.andes-money-amount__cents');
        const cents = centsEl ? centsEl.textContent.padStart(2, '0') : '00';
        const p = parseFloat(`${fraction}.${cents}`);
        if (!isNaN(p) && p > 0) { price = p; break; }
      }

      const titleEl = document.querySelector('h1.ui-pdp-title');
      const title = titleEl ? titleEl.textContent.trim() : null;

      let imageUrl = null;
      const img = document.querySelector('.ui-pdp-gallery__figure img')
        || document.querySelector('img.ui-pdp-image');
      if (img) imageUrl = img.src || img.getAttribute('data-src') || null;

      return { price, title, imageUrl };
    });

    return result;
  } catch (e) {
    return null;
  } finally {
    await releasePage(page);
  }
}

function buildUrl(productId) {
  return `https://www.mercadolivre.com.br/p/${productId}`;
}

function extractId(url) {
  const match = url.match(/\/p\/(ML[A-Z]\d+)/i);
  return match ? match[1] : null;
}

module.exports = { scrape, buildUrl, extractId };

const cheerio = require('cheerio');

function parseBRLPrice(text) {
  const cleaned = text
    .replace(/[R$\s\u00a0]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const price = parseFloat(cleaned);
  return (!isNaN(price) && price > 0) ? price : null;
}

async function scrape(url) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
  });
  if (!response.ok) return null;

  const html = await response.text();
  const $ = cheerio.load(html);

  let price = null;

  // Try sr-only price tag first
  const srOnly = $('.price-tag-text-sr-only').first();
  if (srOnly.length) {
    price = parseBRLPrice(srOnly.text());
  }

  // Fallback: fraction + cents (scoped to second-line to avoid strikethrough)
  if (!price) {
    const fractionEl = $('.ui-pdp-price__second-line .andes-money-amount__fraction').first();
    if (fractionEl.length) {
      const fraction = fractionEl.text().replace(/\./g, '');
      const centsEl = $('.ui-pdp-price__second-line .andes-money-amount__cents').first();
      const cents = centsEl.length ? centsEl.text().padStart(2, '0') : '00';
      const p = parseFloat(`${fraction}.${cents}`);
      if (!isNaN(p) && p > 0) price = p;
    }
  }

  const title = $('h1.ui-pdp-title').text().trim() || null;

  const imageUrl = $('.ui-pdp-gallery__figure img').attr('src')
    || $('figure.ui-pdp-gallery__figure img').attr('data-src')
    || $('img.ui-pdp-image').attr('src')
    || null;

  return { price, title, imageUrl };
}

function buildUrl(productId) {
  return `https://www.mercadolivre.com.br/p/${productId}`;
}

function extractId(url) {
  const match = url.match(/\/p\/(ML[A-Z]\d+)/i);
  return match ? match[1] : null;
}

module.exports = { scrape, buildUrl, extractId };

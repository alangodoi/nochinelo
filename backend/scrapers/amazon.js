const cheerio = require('cheerio');

const PRICE_SELECTORS = [
  '.a-price:not(.a-text-price) .a-offscreen',
  '.priceToPay .a-offscreen',
  '#priceblock_ourprice',
  'span.a-color-price'
];

const TITLE_SELECTOR = '#productTitle';

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
  for (const sel of PRICE_SELECTORS) {
    const el = $(sel).first();
    if (el.length) {
      price = parseBRLPrice(el.text());
      if (price) break;
    }
  }

  const title = $(TITLE_SELECTOR).text().trim() || null;

  const imageUrl = $('#landingImage').attr('src')
    || $('#imgBlkFront').attr('src')
    || $('#main-image').attr('src')
    || null;

  // Coupon extraction
  // Note: coupon clips (#couponsInBuybox) are JS-rendered and empty in server HTML.
  // Only the promo block (.promoPriceBlockMessage) may have server-side content.
  let coupon = null;
  const promoEl = $('.promoPriceBlockMessage, #promoPriceBlockMessage_feature_div').first();
  if (promoEl.length) {
    const text = promoEl.text().replace(/\s+/g, ' ').trim();
    const match = text.match(/(Economize\s+\d+%)\s+com o cupom\s+(\S+)/i)
      || text.match(/(Economize\s+R\$\s*[\d.,]+)\s+com o cupom\s+(\S+)/i);
    if (match) {
      coupon = `${match[1].trim()} com cupom ${match[2].trim()}`;
    } else {
      const promoMatch = text.match(/economize?\s+(?:mais\s+)?(\d+%)[^.]*(?:finaliza|pedido)/i);
      if (promoMatch) coupon = `Economize ${promoMatch[1]} na finalização`;
    }
  }

  return { price, title, imageUrl, coupon };
}

function buildUrl(productId) {
  return `https://www.amazon.com.br/dp/${productId}`;
}

function extractId(url) {
  const match = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

module.exports = { scrape, buildUrl, extractId };

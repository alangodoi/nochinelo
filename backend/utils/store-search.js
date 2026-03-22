const cheerio = require('cheerio');
const { getPage, releasePage } = require('./browser');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseBRLPrice(text) {
  const cleaned = text
    .replace(/[R$\s\u00a0]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const price = parseFloat(cleaned);
  return (!isNaN(price) && price > 0) ? price : null;
}

// --- Amazon ---

async function searchAmazon(query) {
  const url = `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'User-Agent': USER_AGENT
      }
    });
    if (!response.ok) return [];

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('[data-component-type="s-search-result"]').each((_, el) => {
      if (results.length >= 5) return false;

      const $el = $(el);
      const linkEl = $el.find('h2 a').first();
      const href = linkEl.attr('href');
      if (!href) return;

      const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
      if (!asinMatch) return;

      const title = linkEl.text().trim();
      const priceEl = $el.find('.a-price:not(.a-text-price) .a-offscreen').first();
      const price = priceEl.length ? parseBRLPrice(priceEl.text()) : null;
      const imageUrl = $el.find('img.s-image').first().attr('src') || null;

      if (title) {
        results.push({
          url: `https://www.amazon.com.br/dp/${asinMatch[1]}`,
          title,
          source: 'amazon',
          price,
          imageUrl
        });
      }
    });

    return results;
  } catch (e) {
    console.error('[SEARCH] Amazon error:', e.message);
    return [];
  }
}

// --- Mercado Livre ---

async function searchMercadoLivre(query) {
  const page = await getPage();
  try {
    const url = `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('.ui-search-layout__item', { timeout: 10000 }).catch(() => {});

    const results = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('.ui-search-layout__item');

      for (const card of cards) {
        if (items.length >= 5) break;

        const linkEl = card.querySelector('a.ui-search-link, a.ui-search-item__group__element');
        const href = linkEl?.href;
        if (!href) continue;

        const mlMatch = href.match(/\/p\/(ML[A-Z]\d+)/i)
          || href.match(/MLB-?\d+/i);
        if (!mlMatch) continue;

        const titleEl = card.querySelector('.ui-search-item__title, h2');
        const title = titleEl?.textContent?.trim();
        if (!title) continue;

        let price = null;
        const fractionEl = card.querySelector('.andes-money-amount__fraction');
        if (fractionEl) {
          const fraction = fractionEl.textContent.replace(/\./g, '');
          const centsEl = card.querySelector('.andes-money-amount__cents');
          const cents = centsEl ? centsEl.textContent.padStart(2, '0') : '00';
          const p = parseFloat(`${fraction}.${cents}`);
          if (!isNaN(p) && p > 0) price = p;
        }

        const imgEl = card.querySelector('img');
        const imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || null;

        // Normalize URL to /p/MLBXXXXXX format
        const pMatch = href.match(/\/p\/(ML[A-Z]\d+)/i);
        const productUrl = pMatch
          ? `https://www.mercadolivre.com.br/p/${pMatch[1]}`
          : href.split('?')[0];

        items.push({ url: productUrl, title, source: 'mercadolivre', price, imageUrl });
      }
      return items;
    });

    return results;
  } catch (e) {
    console.error('[SEARCH] Mercado Livre error:', e.message);
    return [];
  } finally {
    await releasePage(page);
  }
}

// --- KaBuM! ---

async function searchKabum(query) {
  const url = `https://www.kabum.com.br/busca/${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'User-Agent': USER_AGENT
      }
    });
    if (!response.ok) return [];

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    // KaBuM! uses Next.js — try __NEXT_DATA__ first
    const nextDataEl = $('script#__NEXT_DATA__');
    if (nextDataEl.length) {
      try {
        const nextData = JSON.parse(nextDataEl.html());
        const products = nextData?.props?.pageProps?.data?.catalogServer?.products
          || nextData?.props?.pageProps?.data?.products
          || [];

        for (const p of products) {
          if (results.length >= 5) break;
          const id = p.code || p.id;
          if (!id) continue;

          results.push({
            url: `https://www.kabum.com.br/produto/${id}`,
            title: p.name || p.title || null,
            source: 'kabum',
            price: p.priceWithDiscount || p.price || null,
            imageUrl: p.image || null
          });
        }
      } catch (e) {}
    }

    return results;
  } catch (e) {
    console.error('[SEARCH] KaBuM! error:', e.message);
    return [];
  }
}

// --- Shopee ---

async function searchShopee(query) {
  const page = await getPage();
  try {
    let apiResults = null;
    const apiPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15000);

      page.on('response', async (response) => {
        const reqUrl = response.url();
        if (!reqUrl.includes('/api/v4/search/search_items')) return;
        try {
          const json = await response.json();
          if (json?.items) {
            clearTimeout(timeout);
            resolve(json.items);
          }
        } catch (e) {}
      });
    });

    const url = `https://shopee.com.br/search?keyword=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    apiResults = await apiPromise;

    if (!apiResults) return [];

    const results = [];
    for (const entry of apiResults) {
      if (results.length >= 5) break;
      const item = entry.item_basic || entry;
      if (!item.shopid || !item.itemid) continue;

      const rawPrice = item.price || item.price_min;
      const price = rawPrice ? rawPrice / 100000 : null;
      const imageHash = item.image;
      const imageUrl = imageHash
        ? `https://down-br.img.susercontent.com/file/${imageHash}`
        : null;

      results.push({
        url: `https://shopee.com.br/product-i.${item.shopid}.${item.itemid}`,
        title: item.name || null,
        source: 'shopee',
        price,
        imageUrl
      });
    }

    return results;
  } catch (e) {
    console.error('[SEARCH] Shopee error:', e.message);
    return [];
  } finally {
    await releasePage(page);
  }
}

// --- Main search function ---

const SEARCHERS = {
  amazon: searchAmazon,
  mercadolivre: searchMercadoLivre,
  kabum: searchKabum,
  shopee: searchShopee
};

/**
 * Search all supported stores for a product by EAN (excluding the source store).
 * Only searches by EAN to guarantee exact product match.
 * Returns array of { url, title, source, price, imageUrl }.
 */
async function searchByEAN(ean, excludeSource) {
  if (!ean || !/^\d{8,14}$/.test(ean)) return [];

  const sources = Object.keys(SEARCHERS).filter(s => s !== excludeSource);
  const allResults = [];

  for (const source of sources) {
    try {
      const results = await SEARCHERS[source](ean);
      // EAN search typically returns only the exact product (first result is best)
      if (results.length > 0) {
        allResults.push(results[0]);
      }
    } catch (e) {
      console.error(`[SEARCH] ${source} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  return allResults;
}

module.exports = { searchByEAN };

const { getPage, releasePage, loadCookies } = require('../utils/browser');

async function scrape(url) {
  const page = await getPage();
  try {
    const hasCookies = await loadCookies(page, 'shopee');

    // Set up API response interception before navigating
    let apiData = null;
    const apiPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15000);

      page.on('response', async (response) => {
        const reqUrl = response.url();
        if (!/\/api\/v4\/(item\/get|pdp\/get_pc)/.test(reqUrl)) return;
        try {
          const json = await response.json();
          const data = json?.data;
          if (data && (data.name || data.item?.name)) {
            clearTimeout(timeout);
            resolve(data);
          }
        } catch (e) {}
      });
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    apiData = await apiPromise;

    if (apiData) {
      const item = apiData.item || apiData;
      const rawPrice = item.price || item.price_min;
      const price = rawPrice ? rawPrice / 100000 : null;
      const title = item.name || null;
      const imageHash = item.image;
      const imageUrl = imageHash
        ? `https://down-br.img.susercontent.com/file/${imageHash}`
        : null;

      if (price) return { price, title, imageUrl };
    }

    // Fallback: extract title and image from meta tags (no login needed)
    const meta = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      const ogImage = document.querySelector('meta[property="og:image"]');
      let title = ogTitle?.getAttribute('content') || null;
      if (title) title = title.replace(/\s*\|\s*Shopee.*$/i, '').trim();
      const imageUrl = ogImage?.getAttribute('content') || null;
      return { title, imageUrl };
    });

    if (!hasCookies && meta.title) {
      console.log('[SHOPEE] Sem cookies de login. Execute: node login-shopee.js');
    }

    return { price: null, title: meta.title, imageUrl: meta.imageUrl };
  } catch (e) {
    return null;
  } finally {
    await releasePage(page);
  }
}

function buildUrl(productId) {
  return `https://shopee.com.br/product-i.${productId}`;
}

function extractId(url) {
  const match = url.match(/-i\.(\d+\.\d+)/);
  return match ? match[1] : null;
}

module.exports = { scrape, buildUrl, extractId };

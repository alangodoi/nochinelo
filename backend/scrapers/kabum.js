const cheerio = require('cheerio');

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
  let title = null;
  let imageUrl = null;

  // Extract from JSON-LD (most reliable — Next.js SSR embeds structured data)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Product' || json.name) {
        title = title || json.name || null;
        imageUrl = imageUrl || json.image || null;
        const offer = json.offers?.price || json.offers?.lowPrice;
        if (offer) price = price || parseFloat(offer);
      }
    } catch (e) {}
  });

  // Fallback: Next.js __NEXT_DATA__ script (has priceWithDiscount)
  if (!price) {
    const nextDataEl = $('script#__NEXT_DATA__');
    if (nextDataEl.length) {
      try {
        const nextData = JSON.parse(nextDataEl.html());
        const product = nextData?.props?.pageProps?.product
          || nextData?.props?.pageProps?.initialData?.product;
        if (product) {
          price = price || product.priceWithDiscount || product.price || null;
          title = title || product.name || null;
          imageUrl = imageUrl || product.image || null;
        }
      } catch (e) {}
    }
  }

  // Fallback: meta tags
  if (!title) {
    title = $('meta[property="og:title"]').attr('content') || null;
  }
  if (!imageUrl) {
    imageUrl = $('meta[property="og:image"]').attr('content') || null;
  }

  if (price && isNaN(price)) price = null;

  return { price, title, imageUrl };
}

function buildUrl(productId) {
  return `https://www.kabum.com.br/produto/${productId}`;
}

function extractId(url) {
  const match = url.match(/kabum\.com\.br\/produto\/(\d+)/);
  return match ? match[1] : null;
}

module.exports = { scrape, buildUrl, extractId };

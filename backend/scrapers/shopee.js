async function scrape(url) {
  const id = extractId(url);
  if (!id) return null;

  const [shopId, itemId] = id.split('.');

  // Try the item detail API first, then fallback to PDP API
  const apis = [
    `https://shopee.com.br/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
    `https://shopee.com.br/api/v4/pdp/get_pc?item_id=${itemId}&shop_id=${shopId}`
  ];

  for (const apiUrl of apis) {
    try {
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://shopee.com.br/'
        }
      });
      if (!response.ok) continue;

      const json = await response.json();
      const data = json.data;
      if (!data) continue;

      // Price is in units of 1/100000 BRL
      const rawPrice = data.price || data.price_min;
      const price = rawPrice ? rawPrice / 100000 : null;
      const title = data.name || null;

      const imageHash = data.image;
      const imageUrl = imageHash
        ? `https://down-br.img.susercontent.com/file/${imageHash}`
        : null;

      if (price) return { price, title, imageUrl };
    } catch (e) {
      continue;
    }
  }

  return null;
}

function buildUrl(productId) {
  return `https://shopee.com.br/-i.${productId}`;
}

function extractId(url) {
  const match = url.match(/-i\.(\d+\.\d+)/);
  return match ? match[1] : null;
}

module.exports = { scrape, buildUrl, extractId };

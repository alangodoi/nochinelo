const amazon = require('./amazon');
const mercadolivre = require('./mercadolivre');
const kabum = require('./kabum');
const shopee = require('./shopee');

const scrapers = { amazon, mercadolivre, kabum, shopee };

/**
 * Detect merchant from URL and return { source, productId, scraper }
 */
function detectFromUrl(url) {
  for (const [source, scraper] of Object.entries(scrapers)) {
    const productId = scraper.extractId(url);
    if (productId) return { source, productId, scraper };
  }
  return null;
}

function getScraper(source) {
  return scrapers[source] || null;
}

module.exports = { detectFromUrl, getScraper, scrapers };

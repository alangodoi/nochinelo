const API_BASE = 'http://localhost:3000';
const API_KEY = 'dev-key-change-me';

// Poll for alerts every 5 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000;
let notifiedAlerts = new Set();
let notifiedUnavailable = new Set();

// --- Message handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_API_BASE') {
    sendResponse({ apiBase: API_BASE });
    return false;
  }
  if (msg.type === 'PRICE_UPDATE') {
    handlePriceUpdate(msg);
    return false;
  }
  return false;
});

async function handlePriceUpdate(msg) {
  const { productId, source, price, title, imageUrl, url } = msg;
  if (!productId) return;
  try {
    const res = await fetch(`${API_BASE}/api/products/${productId}`, {
      headers: { 'X-API-Key': API_KEY }
    });
    if (!res.ok) return; // product not tracked

    const product = await res.json();
    if (!product.tracked) return;

    // Update product data if we have new info
    const updates = {};
    if (title && !product.title) updates.title = title;
    if (url) updates.url = url;

    if (Object.keys(updates).length > 0) {
      await fetch(`${API_BASE}/api/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify(updates)
      });
    }

    // Report price to backend
    if (price) {
      await fetch(`${API_BASE}/api/products/${productId}/price`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({ price, title, imageUrl })
      });
    }
  } catch (e) {
    // Backend might be offline
  }
}

// --- Alert polling ---

async function pollAlerts() {
  try {
    const response = await fetch(`${API_BASE}/api/alerts`, { headers: { 'X-API-Key': API_KEY } });
    if (!response.ok) return;

    const { priceAlerts, unavailableAlerts } = await response.json();

    for (const alert of priceAlerts) {
      if (!notifiedAlerts.has(alert.id)) {
        notifiedAlerts.add(alert.id);
        chrome.notifications.create(`alert-${alert.id}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Alerta de Preço!',
          message: `${alert.title}\nAgora: R$ ${alert.currentPrice.toFixed(2)} (meta: R$ ${alert.targetPrice.toFixed(2)})`,
          priority: 2
        });
      }
    }

    // Clear alerts that are no longer active
    const activeAlertIds = new Set(priceAlerts.map(a => a.id));
    for (const id of notifiedAlerts) {
      if (!activeAlertIds.has(id)) notifiedAlerts.delete(id);
    }

    for (const alert of unavailableAlerts) {
      if (!notifiedUnavailable.has(alert.id)) {
        notifiedUnavailable.add(alert.id);
        chrome.notifications.create(`unavail-${alert.id}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Produto Indisponível',
          message: `"${alert.title}" não foi encontrado após 3 tentativas. Verifique ou substitua o link.`,
          priority: 1
        });
      }
    }

    const activeUnavailIds = new Set(unavailableAlerts.map(a => a.id));
    for (const id of notifiedUnavailable) {
      if (!activeUnavailIds.has(id)) notifiedUnavailable.delete(id);
    }
  } catch (e) {
    // Backend might be offline — silently ignore
  }
}

// Start polling
setInterval(pollAlerts, POLL_INTERVAL_MS);
// Initial poll after 10s
setTimeout(pollAlerts, 10000);

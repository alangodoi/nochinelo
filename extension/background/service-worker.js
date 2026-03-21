const API_BASE = 'http://localhost:3000';

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
  return false;
});

// --- Alert polling ---

async function pollAlerts() {
  try {
    const response = await fetch(`${API_BASE}/api/alerts`);
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

const API_BASE = 'http://localhost:3000';

const MERCHANTS = {
  amazon: {
    name: 'Amazon',
    hostPattern: 'amazon.com.br',
    idPattern: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i,
    defaultTitle: 'Produto Amazon'
  },
  mercadolivre: {
    name: 'Mercado Livre',
    hostPattern: 'mercadolivre.com.br',
    idPattern: /\/p\/(ML[A-Z]\d+)/i,
    defaultTitle: 'Produto Mercado Livre'
  },
  shopee: {
    name: 'Shopee',
    hostPattern: 'shopee.com.br',
    idPattern: /-i\.(\d+\.\d+)/,
    defaultTitle: 'Produto Shopee'
  },
  kabum: {
    name: 'KaBuM!',
    hostPattern: 'kabum.com.br',
    idPattern: /\/produto\/(\d+)/,
    defaultTitle: 'Produto KaBuM!'
  }
};

// --- Affiliate tags (extension owner's tags, not user-configurable) ---
const AFFILIATE_TAGS = { amazon: 'MEUTAG-20' };

function buildAffiliateUrl(url, source) {
  const tag = AFFILIATE_TAGS[source];
  if (!tag) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('tag', tag);
    return u.toString();
  } catch (e) {
    return url;
  }
}

// --- API helpers ---

const API_KEY = 'dev-key-change-me';
const API_HEADERS = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'X-API-Key': API_KEY } });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: API_HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error: ${res.status}`);
  }
  return res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: API_HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: { 'X-API-Key': API_KEY } });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// --- State ---
let currentProductId = null;
let currentSource = null;
let chartInstance = null;
let currentHistory = [];       // full history for current-page chart
let detailHistory = [];        // full history for detail chart
const DEFAULT_RANGE_DAYS = 45;
let originTabId = null;        // the product page tab that opened this popout

// --- DOM refs ---
const tabCurrent = document.getElementById('tabCurrent');
const tabAll = document.getElementById('tabAll');
const viewCurrent = document.getElementById('viewCurrent');
const viewAll = document.getElementById('viewAll');
const notSupported = document.getElementById('notSupported');
const productInfo = document.getElementById('productInfo');
const productImage = document.getElementById('productImage');
const productSource = document.getElementById('productSource');
const productTitle = document.getElementById('productTitle');
const productPrice = document.getElementById('productPrice');
const priceTrend = document.getElementById('priceTrend');
const lowestPrice = document.getElementById('lowestPrice');
const highestPrice = document.getElementById('highestPrice');
const targetPriceInput = document.getElementById('targetPrice');
const btnSetAlert = document.getElementById('btnSetAlert');
const alertStatus = document.getElementById('alertStatus');
const btnTrack = document.getElementById('btnTrack');
const btnRemove = document.getElementById('btnRemove');
const alertSection = document.querySelector('.alert-section');
const couponBanner = document.getElementById('couponBanner');
const productList = document.getElementById('productList');
const noProducts = document.getElementById('noProducts');
const searchInput = document.getElementById('searchInput');

// Filter tracked products list
searchInput.addEventListener('input', () => {
  const query = searchInput.value.toLowerCase().trim();
  productList.querySelectorAll('li').forEach(li => {
    const title = li.querySelector('.product-item-title')?.textContent.toLowerCase() || '';
    li.style.display = title.includes(query) ? '' : 'none';
  });
});

// Detail view refs
const viewDetail = document.getElementById('viewDetail');
const btnBack = document.getElementById('btnBack');
const detailImage = document.getElementById('detailImage');
const detailSource = document.getElementById('detailSource');
const detailTitle = document.getElementById('detailTitle');
const detailPrice = document.getElementById('detailPrice');
const detailTrend = document.getElementById('detailTrend');
const detailLowest = document.getElementById('detailLowest');
const detailHighest = document.getElementById('detailHighest');
const detailTargetPrice = document.getElementById('detailTargetPrice');
const btnDetailSetAlert = document.getElementById('btnDetailSetAlert');
const detailAlertStatus = document.getElementById('detailAlertStatus');
const detailCouponBanner = document.getElementById('detailCouponBanner');
const btnViewProduct = document.getElementById('btnViewProduct');
const btnDetailRemove = document.getElementById('btnDetailRemove');
let detailChartInstance = null;
let detailProductId = null;

// --- Tab switching ---
tabCurrent.addEventListener('click', () => switchTab('current'));
tabAll.addEventListener('click', () => switchTab('all'));

function switchTab(tab) {
  tabCurrent.classList.toggle('active', tab === 'current');
  tabAll.classList.toggle('active', tab === 'all');
  viewCurrent.style.display = 'none';
  viewAll.style.display = 'none';
  viewDetail.style.display = 'none';
  if (tab === 'current') {
    viewCurrent.style.display = 'block';
    if (currentProductId) showCurrentProduct();
  } else {
    viewAll.style.display = 'block';
    renderProductList();
  }
}

// --- Extract product info from URL ---
function extractProductInfo(url) {
  try {
    const hostname = new URL(url).hostname;
    for (const [key, merchant] of Object.entries(MERCHANTS)) {
      if (hostname.includes(merchant.hostPattern)) {
        const match = url.match(merchant.idPattern);
        if (match) return { productId: match[1], source: key };
      }
    }
  } catch (e) {}
  return null;
}

// --- Init ---

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && !tab.url?.startsWith('chrome-extension://') && !tab.url?.startsWith('chrome://')) {
    originTabId = tab.id;
    return tab;
  }
  return null;
}

async function refreshCurrentTab() {
  currentProductId = null;
  currentSource = null;

  const tab = await getActiveTab();
  if (tab?.url) {
    const info = extractProductInfo(tab.url);
    if (info) {
      currentProductId = info.productId;
      currentSource = info.source;
    }
  }

  if (currentProductId) {
    await showCurrentProduct();
  } else {
    notSupported.style.display = 'block';
    productInfo.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => refreshCurrentTab());

// Re-detect product when user switches tabs or navigates
chrome.tabs.onActivated.addListener(() => refreshCurrentTab());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === originTabId && changeInfo.status === 'complete') {
    refreshCurrentTab();
  }
});

function setProductImage(imgEl, url) {
  if (url) {
    imgEl.src = url;
    imgEl.classList.remove('hidden');
  } else {
    imgEl.src = '';
    imgEl.classList.add('hidden');
  }
}

async function showCurrentProduct() {
  notSupported.style.display = 'none';
  productInfo.style.display = 'block';

  // Reset all fields to avoid stale state
  productTitle.textContent = '';
  productPrice.textContent = '—';
  priceTrend.textContent = '';
  priceTrend.className = 'trend';
  lowestPrice.textContent = '—';
  highestPrice.textContent = '—';
  couponBanner.style.display = 'none';
  alertSection.style.display = 'none';
  alertStatus.textContent = '';
  targetPriceInput.value = '';
  setProductImage(productImage, null);
  btnTrack.style.display = 'none';
  btnTrack.disabled = false;
  btnTrack.textContent = 'Rastrear Produto';
  btnRemove.style.display = 'none';
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  resetRangeButtons('chartRangeButtons');

  let product = null;
  let history = [];

  try {
    product = await apiGet(`/api/products/${currentProductId}`);
    history = await apiGet(`/api/products/${currentProductId}/history`);
  } catch (e) {
    // Product not tracked yet
  }

  // Source badge
  const sourceName = MERCHANTS[currentSource]?.name || currentSource;
  productSource.textContent = sourceName;

  if (product && product.tracked) {
    productTitle.textContent = product.title;
    setProductImage(productImage, product.imageUrl);
    productPrice.textContent = product.currentPrice != null
      ? `R$ ${product.currentPrice.toFixed(2)}`
      : '—';

    // Unavailable banner
    let banner = document.getElementById('unavailableBanner');
    const merchantName = MERCHANTS[product.source]?.name || 'loja';
    if (product.unavailable) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'unavailableBanner';
        banner.className = 'unavailable-banner';
        productInfo.insertBefore(banner, productInfo.firstChild);
      }
      banner.textContent = `Este produto parece estar indisponível na ${merchantName}.`;
      banner.style.display = 'block';
    } else if (banner) {
      banner.style.display = 'none';
    }

    // Filter out marker entries for calculations
    const priceEntries = history.filter(h => h.price != null);

    // Trend
    if (priceEntries.length >= 2) {
      const prev = priceEntries[priceEntries.length - 2].price;
      const curr = priceEntries[priceEntries.length - 1].price;
      if (curr < prev) {
        priceTrend.textContent = `▼ R$ ${(prev - curr).toFixed(2)}`;
        priceTrend.className = 'trend down';
      } else if (curr > prev) {
        priceTrend.textContent = `▲ R$ ${(curr - prev).toFixed(2)}`;
        priceTrend.className = 'trend up';
      } else {
        priceTrend.textContent = '―';
        priceTrend.className = 'trend stable';
      }
    }

    // Min/Max
    if (priceEntries.length > 0) {
      const prices = priceEntries.map(h => h.price);
      lowestPrice.textContent = `R$ ${Math.min(...prices).toFixed(2)}`;
      highestPrice.textContent = `R$ ${Math.max(...prices).toFixed(2)}`;
    }

    // Coupon — prefer live DOM (content script) over backend data
    if (product.coupon) {
      couponBanner.textContent = product.coupon;
      couponBanner.style.display = 'flex';
    } else {
      couponBanner.style.display = 'none';
    }
    // Also ask the content script for live coupon (JS-rendered coupons won't be in backend HTML)
    if (originTabId) {
      chrome.tabs.sendMessage(originTabId, { type: 'GET_PRICE' }, (response) => {
        if (response?.coupon) {
          couponBanner.textContent = response.coupon;
          couponBanner.style.display = 'flex';
        }
      });
    }

    // Alert
    alertSection.style.display = 'block';
    if (product.targetPrice) {
      targetPriceInput.value = product.targetPrice;
      alertStatus.textContent = `Alerta ativo: R$ ${product.targetPrice.toFixed(2)}`;
    } else {
      targetPriceInput.value = '';
      alertStatus.textContent = '';
    }

    btnTrack.style.display = 'none';
    btnRemove.style.display = 'block';

    currentHistory = history;
    renderChart(history, DEFAULT_RANGE_DAYS);
    setupRangeButtons('chartRangeButtons', history, (filtered) => renderChart(filtered));
  } else {
    // Not tracked (or never tracked) — show what we have, offer to track
    // Use backend data if product exists but is untracked
    if (product && !product.tracked) {
      productTitle.textContent = product.title || 'Produto não rastreado';
      productPrice.textContent = product.currentPrice != null
        ? `R$ ${product.currentPrice.toFixed(2)}` : '—';
      setProductImage(productImage, product.imageUrl);
      if (product.coupon) {
        couponBanner.textContent = product.coupon;
        couponBanner.style.display = 'flex';
      } else {
        couponBanner.style.display = 'none';
      }
    } else {
      productTitle.textContent = 'Produto não rastreado';
      productPrice.textContent = '—';
      setProductImage(productImage, null);
      couponBanner.style.display = 'none';
    }

    // Also ask content script for live data (may have fresher price/coupon)
    if (originTabId) {
      chrome.tabs.sendMessage(originTabId, { type: 'GET_PRICE' }, (response) => {
        if (response?.price) {
          productPrice.textContent = `R$ ${response.price.toFixed(2)}`;
        }
        if (response?.title) productTitle.textContent = response.title;
        if (response?.imageUrl) setProductImage(productImage, response.imageUrl);
        if (response?.coupon) {
          couponBanner.textContent = response.coupon;
          couponBanner.style.display = 'flex';
        }
      });
    }

    alertSection.style.display = 'none';
    btnTrack.style.display = 'block';
    btnTrack.disabled = false;
    btnTrack.textContent = 'Rastrear Produto';
    btnRemove.style.display = 'none';
  }
}

// --- Track button ---
btnTrack.addEventListener('click', async () => {
  if (!originTabId) return;
  let tab;
  try { tab = await chrome.tabs.get(originTabId); } catch (e) { return; }
  if (!tab?.url) return;

  btnTrack.disabled = true;
  btnTrack.textContent = 'Adicionando...';

  try {
    const product = await apiPost('/api/products', { url: tab.url });

    // If backend scraper couldn't get data, try sending
    // data from the content script
    if (!product.title || !product.currentPrice) {
      try {
        const liveData = await new Promise((resolve) => {
          chrome.tabs.sendMessage(originTabId, { type: 'GET_PRICE' }, resolve);
        });
        if (liveData && (liveData.price || liveData.title)) {
          await apiPost(`/api/products/${product.id}/price`, {
            price: liveData.price,
            title: liveData.title,
            imageUrl: liveData.imageUrl
          });
        }
      } catch (e) {
        // Content script might not be ready
      }
    }

    // Show cheaper alternative banner if available
    if (product.cheaperAlternative) {
      const alt = product.cheaperAlternative;
      const altName = MERCHANTS[alt.source]?.name || alt.source;
      showAlternativeBanner(alt, altName, product.id);
    }

    await showCurrentProduct();
  } catch (e) {
    console.error('Failed to track product:', e);
    btnTrack.textContent = 'Erro ao adicionar';
    setTimeout(() => {
      btnTrack.textContent = 'Rastrear Produto';
      btnTrack.disabled = false;
    }, 2000);
  }
});

function showAlternativeBanner(alt, storeName, currentId) {
  // Remove existing banner
  document.getElementById('altBanner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'altBanner';
  banner.className = 'alternative-banner';
  banner.innerHTML = `
    <p>Mesmo produto mais barato na <strong>${escapeHTML(storeName)}</strong> por <strong>R$ ${alt.currentPrice.toFixed(2)}</strong></p>
    <div class="alt-actions">
      <button id="btnUseAlt" class="btn-alt-use">Rastrear o mais barato</button>
      <button id="btnKeepCurrent" class="btn-alt-keep">Manter atual</button>
    </div>
  `;
  productInfo.insertBefore(banner, productInfo.querySelector('.price-card'));

  document.getElementById('btnUseAlt').addEventListener('click', async () => {
    try {
      await apiPost(`/api/products/${currentId}/replace`, { url: alt.url });
      banner.remove();
      await showCurrentProduct();
    } catch (e) {
      console.error('Failed to replace:', e);
    }
  });

  document.getElementById('btnKeepCurrent').addEventListener('click', () => {
    banner.remove();
  });
}

// --- Remove button ---
btnRemove.addEventListener('click', async () => {
  try {
    await apiDelete(`/api/products/${currentProductId}`);
    await showCurrentProduct();
  } catch (e) {
    console.error('Failed to remove product:', e);
  }
});

// --- Alert button ---
btnSetAlert.addEventListener('click', async () => {
  const target = parseFloat(targetPriceInput.value);
  if (isNaN(target) || target <= 0) {
    alertStatus.textContent = 'Informe um valor válido.';
    alertStatus.style.color = '#e53e3e';
    return;
  }

  try {
    await apiPatch(`/api/products/${currentProductId}`, { targetPrice: target });
    alertStatus.textContent = `Alerta definido: R$ ${target.toFixed(2)}`;
    alertStatus.style.color = '#38a169';
  } catch (e) {
    alertStatus.textContent = 'Erro ao definir alerta.';
    alertStatus.style.color = '#e53e3e';
  }
});

// --- Chart ---

function filterHistoryByDays(history, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return history.filter(h => new Date(h.ts).getTime() >= cutoff);
}

function resetRangeButtons(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === String(DEFAULT_RANGE_DAYS));
  });
}

function setupRangeButtons(containerId, history, renderFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  // Clone buttons to remove old listeners
  container.querySelectorAll('.range-btn').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
  });
  container.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const days = parseInt(btn.dataset.range, 10);
      renderFn(filterHistoryByDays(history, days));
    });
  });
}

function renderChart(history, days) {
  const filtered = days ? filterHistoryByDays(history, days) : history;
  if (filtered.length === 0) return;

  const ctx = document.getElementById('priceChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  const labels = [];
  const data = [];
  const markerIndices = [];

  filtered.forEach((h, i) => {
    const d = new Date(h.ts);
    labels.push(d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));
    if (h.event === 'replaced') {
      data.push(null);
      markerIndices.push(i);
    } else {
      data.push(h.price);
    }
  });

  const replacementMarkerPlugin = {
    id: 'replacementMarker',
    afterDraw(chart) {
      if (markerIndices.length === 0) return;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const ctx = chart.ctx;

      markerIndices.forEach(idx => {
        const x = xScale.getPixelForValue(idx);
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#a0aec0';
        ctx.lineWidth = 1;
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.stroke();
        ctx.fillStyle = '#718096';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Substituído', x, yScale.top - 4);
        ctx.restore();
      });
    }
  };

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Preço (R$)',
        data,
        borderColor: '#ff9900',
        backgroundColor: 'rgba(255, 153, 0, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: '#ff9900',
        borderWidth: 2,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (tooltipCtx) => tooltipCtx.parsed.y != null
              ? `R$ ${tooltipCtx.parsed.y.toFixed(2)}`
              : 'Produto substituído'
          }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          ticks: {
            callback: v => `R$${v.toFixed(0)}`
          }
        },
        x: {
          ticks: {
            maxTicksLimit: 8
          }
        }
      }
    },
    plugins: [replacementMarkerPlugin]
  });
}

// --- Detail view (from Rastreados list) ---

function showView(view) {
  viewCurrent.style.display = 'none';
  viewAll.style.display = 'none';
  viewDetail.style.display = 'none';
  view.style.display = 'block';
}

async function showProductDetail(id) {
  detailProductId = id;
  showView(viewDetail);
  resetRangeButtons('detailRangeButtons');

  let product, history;
  try {
    [product, history] = await Promise.all([
      apiGet(`/api/products/${id}`),
      apiGet(`/api/products/${id}/history`)
    ]);
  } catch (e) {
    return;
  }

  const sourceName = MERCHANTS[product.source]?.name || product.source;
  detailSource.textContent = sourceName;
  detailTitle.textContent = product.title || 'Sem título';
  setProductImage(detailImage, product.imageUrl);

  detailPrice.textContent = product.currentPrice != null
    ? `R$ ${product.currentPrice.toFixed(2)}` : '—';

  // Trend
  const priceEntries = history.filter(h => h.price != null);
  detailTrend.textContent = '';
  detailTrend.className = 'trend';
  if (priceEntries.length >= 2) {
    const prev = priceEntries[priceEntries.length - 2].price;
    const curr = priceEntries[priceEntries.length - 1].price;
    if (curr < prev) {
      detailTrend.textContent = `▼ R$ ${(prev - curr).toFixed(2)}`;
      detailTrend.className = 'trend down';
    } else if (curr > prev) {
      detailTrend.textContent = `▲ R$ ${(curr - prev).toFixed(2)}`;
      detailTrend.className = 'trend up';
    } else {
      detailTrend.textContent = '―';
      detailTrend.className = 'trend stable';
    }
  }

  // Min/Max
  detailLowest.textContent = '—';
  detailHighest.textContent = '—';
  if (priceEntries.length > 0) {
    const prices = priceEntries.map(h => h.price);
    detailLowest.textContent = `R$ ${Math.min(...prices).toFixed(2)}`;
    detailHighest.textContent = `R$ ${Math.max(...prices).toFixed(2)}`;
  }

  // Alert
  if (product.targetPrice) {
    detailTargetPrice.value = product.targetPrice;
    detailAlertStatus.textContent = `Alerta ativo: R$ ${product.targetPrice.toFixed(2)}`;
    detailAlertStatus.style.color = '#38a169';
  } else {
    detailTargetPrice.value = '';
    detailAlertStatus.textContent = '';
  }

  // Coupon
  if (product.coupon) {
    detailCouponBanner.textContent = product.coupon;
    detailCouponBanner.style.display = 'flex';
  } else {
    detailCouponBanner.style.display = 'none';
  }

  // Link (with affiliate tag for supported merchants)
  btnViewProduct.href = buildAffiliateUrl(product.url, product.source);

  // Chart
  detailHistory = history;
  renderDetailChart(history, DEFAULT_RANGE_DAYS);
  setupRangeButtons('detailRangeButtons', history, (filtered) => renderDetailChart(filtered));
}

function renderDetailChart(history, days) {
  if (detailChartInstance) detailChartInstance.destroy();
  const filtered = days ? filterHistoryByDays(history, days) : history;
  if (filtered.length === 0) return;

  const ctx = document.getElementById('detailChart').getContext('2d');
  const labels = [];
  const data = [];
  const markerIndices = [];

  filtered.forEach((h, i) => {
    const d = new Date(h.ts);
    labels.push(d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));
    if (h.event === 'replaced') {
      data.push(null);
      markerIndices.push(i);
    } else {
      data.push(h.price);
    }
  });

  const replacementMarkerPlugin = {
    id: 'replacementMarker',
    afterDraw(chart) {
      if (markerIndices.length === 0) return;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const ctx = chart.ctx;
      markerIndices.forEach(idx => {
        const x = xScale.getPixelForValue(idx);
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#a0aec0';
        ctx.lineWidth = 1;
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.stroke();
        ctx.fillStyle = '#718096';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Substituído', x, yScale.top - 4);
        ctx.restore();
      });
    }
  };

  detailChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Preço (R$)',
        data,
        borderColor: '#ff9900',
        backgroundColor: 'rgba(255, 153, 0, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: '#ff9900',
        borderWidth: 2,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (tooltipCtx) => tooltipCtx.parsed.y != null
              ? `R$ ${tooltipCtx.parsed.y.toFixed(2)}`
              : 'Produto substituído'
          }
        }
      },
      scales: {
        y: { beginAtZero: false, ticks: { callback: v => `R$${v.toFixed(0)}` } },
        x: { ticks: { maxTicksLimit: 8 } }
      }
    },
    plugins: [replacementMarkerPlugin]
  });
}

btnBack.addEventListener('click', () => {
  showView(viewAll);
  renderProductList();
});

btnDetailSetAlert.addEventListener('click', async () => {
  const target = parseFloat(detailTargetPrice.value);
  if (isNaN(target) || target <= 0) {
    detailAlertStatus.textContent = 'Informe um valor válido.';
    detailAlertStatus.style.color = '#e53e3e';
    return;
  }
  try {
    await apiPatch(`/api/products/${detailProductId}`, { targetPrice: target });
    detailAlertStatus.textContent = `Alerta definido: R$ ${target.toFixed(2)}`;
    detailAlertStatus.style.color = '#38a169';
  } catch (e) {
    detailAlertStatus.textContent = 'Erro ao definir alerta.';
    detailAlertStatus.style.color = '#e53e3e';
  }
});

btnDetailRemove.addEventListener('click', async () => {
  try {
    await apiDelete(`/api/products/${detailProductId}`);
    showView(viewAll);
    renderProductList();
  } catch (e) {
    console.error('Failed to remove product:', e);
  }
});

btnViewProduct.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: btnViewProduct.href });
});

// --- Product list ---
async function renderProductList() {
  let products = [];
  try {
    products = await apiGet('/api/products');
  } catch (e) {
    noProducts.style.display = 'block';
    noProducts.querySelector('p').textContent = 'Erro ao conectar com o backend.';
    productList.innerHTML = '';
    return;
  }

  if (products.length === 0) {
    noProducts.style.display = 'block';
    productList.innerHTML = '';
    return;
  }

  // Load histories for lowest price calculation
  const histories = {};
  await Promise.all(products.map(async (p) => {
    try {
      histories[p.id] = await apiGet(`/api/products/${p.id}/history`);
    } catch (e) {
      histories[p.id] = [];
    }
  }));

  noProducts.style.display = 'none';
  productList.innerHTML = products.map(p => {
    const checked = p.lastChecked
      ? new Date(p.lastChecked).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—';
    const history = histories[p.id] || [];
    const prices = history.filter(h => h.price != null).map(h => h.price);
    const lowestText = prices.length > 0
      ? `<span class="product-item-lowest">Min R$${Math.min(...prices).toFixed(2)}</span>`
      : '';
    const alertBadge = p.targetPrice
      ? `<span class="product-item-alert">Alerta R$${p.targetPrice.toFixed(2)}</span>`
      : '';
    const unavailBadge = p.unavailable
      ? '<span class="product-item-unavail">Indisponível</span>'
      : '';
    const couponBadge = p.coupon
      ? `<span class="product-item-coupon">${escapeHTML(p.coupon)}</span>`
      : '';
    const sourceName = MERCHANTS[p.source]?.name || p.source;
    const priceText = p.currentPrice != null ? `R$ ${p.currentPrice.toFixed(2)}` : '—';

    const thumbHtml = p.imageUrl
      ? `<img class="product-item-thumb" src="${escapeAttr(p.imageUrl)}" alt="">`
      : `<div class="product-item-thumb placeholder">📦</div>`;

    const replaceUI = p.unavailable
      ? `<button class="btn-replace-toggle" data-product-id="${p.id}">Substituir link</button>
         <div class="replace-section" data-product-id="${p.id}" style="display:none;">
           <div class="suggestions-list" data-product-id="${p.id}"></div>
           <button class="btn-refresh-suggestions" data-product-id="${p.id}" ${p.ean ? '' : 'disabled title="Visite a página do produto para extrair o EAN"'}>Buscar alternativas</button>
           <input type="text" class="replace-url-input" placeholder="Ou cole um link manualmente">
           <div class="replace-actions">
             <button class="btn-replace-confirm">Confirmar</button>
             <button class="btn-replace-cancel">Cancelar</button>
           </div>
           <p class="replace-status"></p>
         </div>`
      : '';

    return `
      <li data-product-id="${p.id}">
        <button class="btn-remove-item" data-product-id="${p.id}" title="Parar de rastrear">×</button>
        ${thumbHtml}
        <div class="product-item-body">
          <div class="product-item-top">
            <span class="source-badge">${escapeHTML(sourceName)}</span>
            ${unavailBadge}
          </div>
          <div class="product-item-title" title="${escapeAttr(p.title || '')}">${escapeHTML(p.title || 'Sem título')}</div>
          ${couponBadge}
          <div class="product-item-bottom">
            <span class="product-item-price">${priceText}${lowestText}${alertBadge}</span>
            <span class="product-item-checked">${checked}</span>
          </div>
          ${replaceUI}
        </div>
      </li>
    `;
  }).join('');

  // Click to open detail view
  productList.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('.btn-remove-item, .btn-replace-toggle, .replace-section')) return;
      showProductDetail(li.dataset.productId);
    });
  });

  // Remove buttons
  productList.querySelectorAll('.btn-remove-item').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.productId;
      try {
        await apiDelete(`/api/products/${id}`);
        renderProductList();
      } catch (err) {
        console.error('Failed to remove product:', err);
      }
    });
  });

  // Replace toggle buttons
  productList.querySelectorAll('.btn-replace-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const section = btn.nextElementSibling;
      section.style.display = section.style.display === 'none' ? 'block' : 'none';
    });
  });

  // Replace confirm buttons
  productList.querySelectorAll('.btn-replace-confirm').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const section = btn.closest('.replace-section');
      const oldId = section.dataset.productId;
      const input = section.querySelector('.replace-url-input');
      const status = section.querySelector('.replace-status');
      const newUrl = input.value.trim();

      if (!newUrl) {
        status.textContent = 'Cole um link de produto.';
        status.style.color = '#e53e3e';
        return;
      }

      const newInfo = extractProductInfo(newUrl);
      if (!newInfo) {
        status.textContent = 'URL inválida. Use um link de produto Amazon, Mercado Livre, KaBuM! ou Shopee.';
        status.style.color = '#e53e3e';
        return;
      }

      if (newInfo.productId === oldId) {
        status.textContent = 'Este é o mesmo produto.';
        status.style.color = '#e53e3e';
        return;
      }

      status.textContent = 'Substituindo...';
      status.style.color = '#718096';

      try {
        await apiPost(`/api/products/${oldId}/replace`, { url: newUrl });
        renderProductList();
      } catch (e) {
        status.textContent = e.message || 'Erro ao substituir. Tente novamente.';
        status.style.color = '#e53e3e';
      }
    });
  });

  // Replace cancel buttons
  productList.querySelectorAll('.btn-replace-cancel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const section = btn.closest('.replace-section');
      section.style.display = 'none';
      section.querySelector('.replace-url-input').value = '';
      section.querySelector('.replace-status').textContent = '';
    });
  });

  // Refresh suggestions buttons
  productList.querySelectorAll('.btn-refresh-suggestions').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const productId = btn.dataset.productId;
      btn.disabled = true;
      btn.textContent = 'Buscando...';
      try {
        const results = await apiPost(`/api/products/${productId}/suggestions/refresh`, {});
        renderSuggestions(productId, results);
      } catch (e) {
        console.error('Failed to refresh suggestions:', e);
      }
      btn.disabled = false;
      btn.textContent = 'Buscar alternativas';
    });
  });

  // Load existing suggestions for unavailable products
  for (const p of products) {
    if (p.unavailable) {
      apiGet(`/api/products/${p.id}/suggestions`).then(suggestions => {
        if (suggestions.length > 0) renderSuggestions(p.id, suggestions);
      }).catch(() => {});
    }
  }
}

function renderSuggestions(productId, suggestions) {
  const container = productList.querySelector(`.suggestions-list[data-product-id="${productId}"]`);
  if (!container) return;

  if (suggestions.length === 0) {
    container.innerHTML = '<p class="suggestions-empty">Nenhuma alternativa encontrada.</p>';
    return;
  }

  const merchantNames = { amazon: 'Amazon', mercadolivre: 'Mercado Livre', kabum: 'KaBuM!', shopee: 'Shopee' };

  container.innerHTML = suggestions.map(s => {
    const sourceName = merchantNames[s.source] || s.source;
    const priceText = s.price ? `R$ ${s.price.toFixed(2)}` : '—';
    const thumbHtml = s.image_url || s.imageUrl
      ? `<img class="suggestion-thumb" src="${escapeAttr(s.image_url || s.imageUrl)}" alt="">`
      : '';

    return `
      <div class="suggestion-card" data-url="${escapeAttr(s.url)}" data-product-id="${productId}">
        ${thumbHtml}
        <div class="suggestion-info">
          <span class="source-badge suggestion-source">${escapeHTML(sourceName)}</span>
          <span class="suggestion-price">${priceText}</span>
        </div>
        <button class="btn-use-suggestion">Usar</button>
      </div>
    `;
  }).join('');

  // Bind "Usar" buttons
  container.querySelectorAll('.btn-use-suggestion').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = btn.closest('.suggestion-card');
      const url = card.dataset.url;
      const oldId = card.dataset.productId;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await apiPost(`/api/products/${oldId}/replace`, { url });
        renderProductList();
      } catch (e) {
        btn.textContent = 'Erro';
        setTimeout(() => { btn.textContent = 'Usar'; btn.disabled = false; }, 2000);
      }
    });
  });
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

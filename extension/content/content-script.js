(() => {
  const MERCHANTS = {
    amazon: {
      hostPattern: 'amazon.com.br',
      idPattern: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i,
      priceSelectors: [
        '.a-price:not(.a-text-price) .a-offscreen',
        '.priceToPay .a-offscreen',
        '#priceblock_ourprice',
        'span.a-color-price'
      ],
      titleSelector: '#productTitle',
      imageSelectors: ['#landingImage', '#imgBlkFront', '#main-image']
    },
    mercadolivre: {
      hostPattern: 'mercadolivre.com.br',
      idPattern: /\/p\/(ML[A-Z]\d+)/i,
      priceSelectors: ['.price-tag-text-sr-only'],
      priceFractionSelector: '.ui-pdp-price__second-line .andes-money-amount__fraction',
      priceCentsSelector: '.ui-pdp-price__second-line .andes-money-amount__cents',
      titleSelector: 'h1.ui-pdp-title',
      imageSelectors: ['.ui-pdp-gallery__figure img', 'img.ui-pdp-image']
    },
    shopee: {
      hostPattern: 'shopee.com.br',
      idPattern: /-i\.(\d+\.\d+)/,
      useDomScrape: true,
      isSPA: true
    }
  };

  function detectMerchant() {
    const hostname = window.location.hostname;
    for (const [key, merchant] of Object.entries(MERCHANTS)) {
      if (hostname.includes(merchant.hostPattern)) return { key, merchant };
    }
    return null;
  }

  function parseBRLPrice(text) {
    const cleaned = text
      .replace(/[R$\s\u00a0]/g, '')
      .replace(/\./g, '')
      .replace(',', '.');
    const price = parseFloat(cleaned);
    return (!isNaN(price) && price > 0) ? price : null;
  }

  function extractPrice(merchant) {
    for (const sel of merchant.priceSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const price = parseBRLPrice(el.textContent);
        if (price) return price;
      }
    }

    if (merchant.priceFractionSelector) {
      const fractionEl = document.querySelector(merchant.priceFractionSelector);
      if (fractionEl) {
        const fraction = fractionEl.textContent.replace(/\./g, '');
        const centsEl = document.querySelector(merchant.priceCentsSelector);
        const cents = centsEl ? centsEl.textContent.padStart(2, '0') : '00';
        const price = parseFloat(`${fraction}.${cents}`);
        if (!isNaN(price) && price > 0) return price;
      }
    }

    return null;
  }

  function extractTitle(merchant) {
    const el = document.querySelector(merchant.titleSelector);
    return el ? el.textContent.trim() : null;
  }

  function extractShopeeFromDOM() {
    const title = document.title
      .replace(/\s*[\|\-–]\s*Shopee.*$/i, '')
      .replace(/\s*[\|\-–]\s*Lojas Oficiais.*$/i, '')
      .trim() || null;

    if (!document.body) return { price: null, title };

    let price = null;
    const elements = document.body.querySelectorAll('div, span');
    for (const el of elements) {
      const text = el.textContent.trim();
      if (text.length > 40) continue;
      const match = text.match(/R\$\s?([\d.]+,\d{2})/);
      if (match) {
        const parsed = parseBRLPrice(match[0]);
        if (parsed && parsed > 1) {
          price = parsed;
          break;
        }
      }
    }

    return { price, title };
  }

  function extractImage(merchant) {
    if (!merchant.imageSelectors) return null;
    for (const sel of merchant.imageSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const src = el.src || el.getAttribute('data-src');
        if (src) return src;
      }
    }
    return null;
  }

  function extractCoupon() {
    // 1. Coupon clips (JS-rendered inside #couponsInBuybox_feature_div)
    //    e.g. "Economize 10% com o cupom MARCENEIRO10"
    const couponsBox = document.querySelector('#couponsInBuybox_feature_div, #couponBadgeRegularVpc, #vpcButton');
    if (couponsBox) {
      const text = couponsBox.textContent.replace(/\s+/g, ' ').trim();
      if (text) {
        const match = text.match(/(Economize\s+\d+%)\s+com o cupom\s+(\S+)/i)
          || text.match(/(Economize\s+R\$\s*[\d.,]+)\s+com o cupom\s+(\S+)/i);
        if (match) return `${match[1].trim()} com cupom ${match[2].trim()}`;
        // Generic coupon text
        const couponMatch = text.match(/cupom\s+(\S+)/i);
        if (couponMatch) return text;
        // Percentage discount clip
        const clipMatch = text.match(/Economize\s+(\d+%)/i);
        if (clipMatch) return `Economize ${clipMatch[1]} (cupom)`;
      }
    }

    // 2. Promo block (server-rendered, e.g. "economize mais 15% na finalização")
    const promoBlock = document.querySelector('.promoPriceBlockMessage, #promoPriceBlockMessage_feature_div');
    if (promoBlock) {
      const text = promoBlock.textContent.replace(/\s+/g, ' ').trim();
      const promoMatch = text.match(/economize?\s+(?:mais\s+)?(\d+%)[^.]*(?:finaliza|pedido)/i);
      if (promoMatch) return `Economize ${promoMatch[1]} na finalização`;
      const couponMatch = text.match(/(Economize\s+\d+%)\s+com o cupom\s+(\S+)/i);
      if (couponMatch) return `${couponMatch[1].trim()} com cupom ${couponMatch[2].trim()}`;
    }

    return null;
  }

  function getProductData(merchant) {
    if (merchant.useDomScrape) {
      return extractShopeeFromDOM();
    }
    return {
      price: extractPrice(merchant),
      title: extractTitle(merchant),
      imageUrl: extractImage(merchant),
      coupon: extractCoupon()
    };
  }

  // --- Main logic ---

  const detected = detectMerchant();
  if (!detected) return;

  const { key: source, merchant } = detected;
  let lastUrl = window.location.href;

  // SPA observer for Shopee
  if (merchant.isSPA) {
    setInterval(() => {
      const url = window.location.href;
      if (url !== lastUrl) {
        lastUrl = url;
      }
    }, 1000);
  }

  // Respond to popup requests for current page price
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PRICE') {
      const url = window.location.href;
      const match = url.match(merchant.idPattern);
      if (!match) {
        sendResponse({ productId: null, source, title: null, price: null, url });
        return false;
      }

      const productId = match[1];
      const { price, title, imageUrl, coupon } = getProductData(merchant);
      sendResponse({ productId, source, title, price, imageUrl, coupon, url });
      return false;
    }
    return false;
  });
})();

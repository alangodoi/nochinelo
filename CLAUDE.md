# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chrome Extension (Manifest V3) that tracks product prices over time on Amazon.com.br, Mercado Livre, KaBuM! and Shopee to identify the best buying opportunity (lowest price). Plain HTML/CSS/JS, no build step.

## Development

Load as unpacked extension at `chrome://extensions` with Developer Mode enabled. No build or install commands needed.

Backend: `cd backend && npm start`. Requires Node.js. Uses Puppeteer (headless Chromium) for JS-rendered pages.

To test the service worker and alarms, use the "Inspect" link next to the service worker in `chrome://extensions`.

## Architecture

**Multi-merchant support**: The extension supports multiple stores via a `MERCHANTS` config object that defines per-store URL patterns, CSS selectors, and capabilities. This config is inlined (not shared via import) in content-script.js and popup.js because popup and content scripts can't use ES module imports.

**Content Script** (`content/content-script.js`): Runs on Amazon.com.br, Mercado Livre, KaBuM! and Shopee pages. Detects the merchant from hostname, extracts product ID from URL, price (merchant-specific CSS selectors or DOM scan for Shopee), and product title. Sends `PRICE_UPDATE` message with `productId` and `source` to service worker. Also responds to `GET_PRICE` messages from the popup.

**Service Worker** (`background/service-worker.js`): Orchestration hub. Handles `PRICE_UPDATE` messages, relays price data to the backend via `POST /api/products/:id/price`. Opens a popout window when the extension icon is clicked. Polls backend for alerts and fires `chrome.notifications` when price drops below target or product becomes unavailable.

**Popup** (`popup/popup.html`): Runs inside a popout window. Two-tab UI — "Página Atual" (current product page info + chart) and "Rastreados" (all tracked products list with source badges). Uses Chart.js v4 (bundled in `lib/`) for price history visualization. MERCHANTS config is inlined (not imported).

**Backend Scrapers** (`backend/scrapers/`): Per-merchant scraper modules. Amazon and KaBuM! use cheerio (server-rendered HTML). Mercado Livre uses Puppeteer with stealth plugin (JS-rendered). Shopee uses Puppeteer for meta tags only (title/image); prices require login and come from the content script.

**Browser Manager** (`backend/utils/browser.js`): Singleton Puppeteer browser instance with lazy-launch, page reuse, and auto-close after 60s idle. Uses `puppeteer-extra` with stealth plugin to avoid bot detection.

## Data schema (backend SQLite)

- `products`: `{ id, source, title, url, current_price, target_price, alert_triggered, added_at, last_checked, fail_count, unavailable, tracked, image_url, coupon }` — `source` is the merchant key (`'amazon'`, `'mercadolivre'`, `'kabum'`, or `'shopee'`). KaBuM! productId is numeric (e.g. `644498`). Shopee productId format is `{shopId}.{itemId}`.
- `price_history`: `{ product_id, ts, price, event?, old_product_id? }` — separated from products for lazy loading. Entries with `event: 'replaced'` and `price: null` mark product link replacements.
- `settings`: `{ key, value }` — e.g. `checkIntervalMinutes`

## Key patterns

- **Price parsing (BRL)**: Remove `R$` and spaces, replace `.` (thousands separator) with nothing, replace `,` (decimal) with `.`, then `parseFloat`. Works for Amazon and Mercado Livre. KaBuM! prices are already in float format from JSON-LD.
- **Product ID extraction**: Amazon: regex `/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i`. Mercado Livre: regex `/\/p\/(ML[A-Z]\d+)/i`. KaBuM!: regex `/\/produto\/(\d+)/`. Shopee: regex `/-i\.(\d+\.\d+)/`.
- **Amazon price selectors cascade**: `.a-price:not(.a-text-price) .a-offscreen` → `.priceToPay .a-offscreen` → `#priceblock_ourprice` → `span.a-color-price`.
- **Mercado Livre price extraction**: Uses Puppeteer. Finds first `.andes-money-amount` with currency symbol, extracts fraction + cents.
- **KaBuM! price extraction**: Server-rendered (Next.js SSR). Backend scraper extracts price, title and image from JSON-LD structured data or `__NEXT_DATA__` script. Prices are already in BRL float format.
- **Shopee price extraction**: Shopee requires login to show prices. Backend scraper can only get title/image from meta tags. Price updates come exclusively from the content script when the user visits the page while logged in. The content script scans the DOM for the highest R$ value.
- **Deduplication**: Only records a new price entry if the price changed or 6+ hours elapsed since the last entry.
- **Background fetches**: Sequential with 3s delay between products. Amazon and KaBuM! use cheerio (fast). Mercado Livre uses Puppeteer (slower, ~15-20s). Shopee is skipped in background checks (requires login).
- **Alert logic**: Notifies once when price drops below target (`alertTriggered` flag), resets when price goes back above target.
- **Unavailable detection**: After 3 consecutive background fetch failures, product is marked `unavailable` and user is notified. User can replace the link with a new product URL (from any supported merchant), preserving price history with a visual marker.

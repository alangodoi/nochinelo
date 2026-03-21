# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chrome Extension (Manifest V3) that tracks product prices over time on Amazon.com.br, Mercado Livre, Shopee and KaBuM! to identify the best buying opportunity (lowest price). Plain HTML/CSS/JS, no build step.

## Development

Load as unpacked extension at `chrome://extensions` with Developer Mode enabled. No build or install commands needed.

To test the service worker and alarms, use the "Inspect" link next to the service worker in `chrome://extensions`.

## Architecture

**Multi-merchant support**: The extension supports multiple stores via a `MERCHANTS` config object that defines per-store URL patterns, CSS selectors, and capabilities. This config is inlined (not shared via import) in content-script.js, offscreen.js, and popup.js because popup and content scripts can't use ES module imports.

**Content Script** (`content/content-script.js`): Runs on Amazon.com.br and Mercado Livre pages. Detects the merchant from hostname, extracts product ID from URL (ASIN for Amazon, MLB ID for Mercado Livre), price (merchant-specific CSS selectors), and product title. Sends `PRICE_UPDATE` message with `productId` and `source` to service worker. Also responds to `GET_PRICE` messages from the popup.

**Service Worker** (`background/service-worker.js`): Orchestration hub. Handles `PRICE_UPDATE` messages, manages `chrome.alarms` for periodic background price checks (Amazon only — Mercado Livre pages are JS-rendered so background fetch can't extract prices), delegates HTML parsing to the offscreen document, fires `chrome.notifications` when price drops below target or product becomes unavailable. Uses ES modules to import from `utils/storage.js`. Runs one-time data migration on install (`migrateToProductId`).

**Offscreen Document** (`offscreen/`): Exists because MV3 service workers lack `DOMParser`. Receives raw HTML and `source` (merchant) via messages, parses it with `DOMParser`, extracts price using merchant-specific selectors, and returns the result.

**Popup** (`popup/`): Two-tab UI — "Página Atual" (current product page info + chart) and "Rastreados" (all tracked products list with source badges). Uses Chart.js v4 (bundled in `lib/`) for price history visualization. Storage helpers and MERCHANTS config are inlined (not imported).

**Storage Utils** (`utils/storage.js`): ES module with helpers for Chrome Storage Local. Used by the service worker via import.

## Data schema (chrome.storage.local)

- `products`: `{ [productId]: { productId, source, title, url, currentPrice, targetPrice, alertTriggered, addedAt, lastChecked, failCount, unavailable } }` — quick lookup map. `source` is the merchant key (`'amazon'`, `'mercadolivre'`, `'shopee'`, or `'kabum'`). Shopee productId format is `{shopId}.{itemId}`. KaBuM! productId is numeric (e.g. `644498`).
- `priceHistory`: `{ [productId]: [{ ts, price, event?, oldProductId? }] }` — separated from products for lazy loading. Entries with `event: 'replaced'` and `price: null` mark product link replacements.
- `settings`: `{ checkIntervalMinutes, maxHistoryPerProduct }`
- `migrated`: boolean flag for one-time ASIN→productId migration

## Key patterns

- **Price parsing (BRL)**: Remove `R$` and spaces, replace `.` (thousands separator) with nothing, replace `,` (decimal) with `.`, then `parseFloat`. Works for both Amazon and Mercado Livre.
- **Product ID extraction**: Amazon: regex `/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i`. Mercado Livre: regex `/\/p\/(ML[A-Z]\d+)/i`. Shopee: regex `/-i\.(\d+\.\d+)/` (captures `shopId.itemId`). KaBuM!: regex `/\/produto\/(\d+)/`.
- **Amazon price selectors cascade**: `.a-price:not(.a-text-price) .a-offscreen` → `.priceToPay .a-offscreen` → `#priceblock_ourprice` → `span.a-color-price`.
- **Mercado Livre price extraction**: First tries `.price-tag-text-sr-only`. Fallback: combines `.andes-money-amount__fraction` + `.andes-money-amount__cents` (scoped to `.ui-pdp-price__second-line` to avoid grabbing the strikethrough price).
- **Deduplication**: Only records a new price entry if the price changed or 6+ hours elapsed since the last entry.
- **Shopee price extraction**: Shopee uses obfuscated CSS class names that change every deploy, and serves a blank HTML shell (all content is JS-rendered). Solution: `shopee-intercept.js` runs at `document_start` and monkey-patches `window.fetch` in the page context (via injected `<script>`) to intercept Shopee's own API calls (`/api/v4/item/get` or `/api/v4/pdp/get_pc`). Data is relayed to the content script via `CustomEvent`. Price from API is divided by 100,000 to get BRL value.
- **KaBuM! price extraction**: Server-rendered (Next.js SSR). Backend scraper extracts price, title and image from JSON-LD structured data or `__NEXT_DATA__` script. Prices are already in BRL float format. Content script uses CSS selectors with meta tag fallback for images.
- **Background fetches**: Sequential with 3s delay between products. Only for merchants with `supportsBackgroundFetch: true` (currently Amazon only). Mercado Livre and Shopee prices update only when the user visits the page. KaBuM! is server-rendered so background fetch works.
- **Alert logic**: Notifies once when price drops below target (`alertTriggered` flag), resets when price goes back above target.
- **Unavailable detection**: After 3 consecutive background fetch failures, product is marked `unavailable` and user is notified. User can replace the link with a new product URL (from any supported merchant), preserving price history with a visual marker.

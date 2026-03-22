#!/usr/bin/env node

/**
 * Opens a visible browser for manual Shopee login.
 * After login, saves cookies to data/shopee-cookies.json for background scraping.
 *
 * Usage: node login-shopee.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, 'data', 'shopee-cookies.json');
const LOGIN_URL = 'https://shopee.com.br/buyer/login';
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function main() {
  console.log('Abrindo browser para login na Shopee...');
  console.log('Faça login normalmente. O browser fechará automaticamente após o login.\n');

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,900'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Poll until URL no longer contains /login (user completed login)
  const start = Date.now();
  let loggedIn = false;

  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const currentUrl = page.url();
    if (!currentUrl.includes('/buyer/login') && !currentUrl.includes('/verify')) {
      loggedIn = true;
      break;
    }
  }

  if (!loggedIn) {
    console.error('Timeout: login não foi completado em 5 minutos.');
    await browser.close();
    process.exit(1);
  }

  // Save cookies
  const cookies = await page.cookies();
  fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));

  console.log(`\nLogin realizado! ${cookies.length} cookies salvos em ${COOKIES_PATH}`);
  console.log('O scraper da Shopee agora pode buscar preços em background.');

  await browser.close();
}

main().catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});

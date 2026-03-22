const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS, 10) || 60000;

let browser = null;
let activePages = 0;
let idleTimer = null;

async function launchBrowser() {
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  browser.on('disconnected', () => { browser = null; });
}

async function getPage() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (!browser || !browser.connected) {
    await launchBrowser();
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  activePages++;
  return page;
}

async function releasePage(page) {
  try {
    if (page && !page.isClosed()) await page.close();
  } catch (e) {}

  activePages = Math.max(0, activePages - 1);

  if (activePages === 0 && browser) {
    idleTimer = setTimeout(async () => {
      if (activePages === 0) await closeBrowser();
    }, IDLE_TIMEOUT_MS);
  }
}

async function closeBrowser() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browser) {
    try { await browser.close(); } catch (e) {}
    browser = null;
  }
}

async function loadCookies(page, name) {
  const cookiePath = path.join(__dirname, '..', 'data', `${name}-cookies.json`);
  try {
    const data = fs.readFileSync(cookiePath, 'utf8');
    const cookies = JSON.parse(data);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await page.setCookie(...cookies);
      return true;
    }
  } catch (e) {}
  return false;
}

module.exports = { getPage, releasePage, closeBrowser, loadCookies };

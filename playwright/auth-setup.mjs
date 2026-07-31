import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { cfg, requireEnv } from '../config/test-config.mjs';

// Credentials are supplied only through environment variables and are never committed.
const testUser = process.env.SCIENCE42_USER;
const testPassword = process.env.SCIENCE42_PASSWORD;
requireEnv('SCIENCE42_USER', testUser);
requireEnv('SCIENCE42_PASSWORD', testPassword);
const baseUrl = process.env.SCIENCE42_BASE_URL || 'http://192.168.0.112:23191';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(new URL(process.env.SCIENCE42_ENTRY_PATH || '/#/cases', baseUrl).href, { waitUntil: 'domcontentloaded' });
// Let the SPA finish rendering its authentication modal before inspecting the page.
await page.waitForTimeout(3_000);

async function firstVisible(selector) {
  const locator = page.locator(selector);
  for (let i = 0; i < await locator.count(); i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function loginDialogVisible() {
  const candidates = [
    page.locator('div[class*="login-section"]'),
    page.locator('[role="dialog"] input[placeholder*="\u624b\u673a"]'),
    page.locator('[role="dialog"] input[placeholder*="\u5bc6\u7801"]')
  ];
  for (const locator of candidates) {
    for (let i = 0; i < await locator.count(); i += 1) {
      if (await locator.nth(i).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function loggedInContentVisible() {
  if (await loginDialogVisible()) return false;
  const candidates = [
    page.locator('textarea'),
    page.locator('[class*="chat-action"]'),
    page.getByText('\u7269\u7406\u6c42\u89e3', { exact: true }),
    page.getByText('\u65b0\u5efa\u804a\u5929', { exact: true }),
    page.locator('[class*="ActionCardPanel"]'),
    page.getByText('\u79d1\u5b66\u7814\u7a76\u6848\u4f8b\u7ba1\u7406', { exact: true }),
    page.getByText('\u7814\u7a76\u6848\u4f8b', { exact: true }),
    page.getByRole('button', { name: '\u65b0\u5efa\u6848\u4f8b', exact: true })
  ];
  for (const locator of candidates) {
    for (let i = 0; i < await locator.count(); i += 1) {
      if (await locator.nth(i).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

let username = null;
let loginPassword = null;
let loginOpened = false;

// The login modal is rendered asynchronously after the initial page load.
// Keep looking for it so the credentials are filled even when the modal is late.
for (let i = 0; i < 60 && !(username && loginPassword); i += 1) {
  username = await firstVisible(
    '#username, input[autocomplete="username"], input[placeholder*="\u624b\u673a"], input[placeholder*="\u90ae\u7bb1"]'
  );
  loginPassword = await firstVisible(
    '#password, input[type="password"], input[placeholder*="\u5bc6\u7801"]'
  );
  if (!(username && loginPassword) && !loginOpened) {
    const loginButton = await firstVisible('button:has-text("\u767b\u5f55"), [role="button"]:has-text("\u767b\u5f55")');
    if (loginButton) {
      await loginButton.click().catch(() => {});
      loginOpened = true;
    }
  }
  if (!(username && loginPassword)) await page.waitForTimeout(500);
}

if (username) {
  if (!loginPassword) throw new Error('Found username field but no visible password field.');
  await username.fill(testUser);
  await loginPassword.fill(testPassword);
  const agreement = page.locator('input[type="checkbox"]');
  if (await agreement.count() === 1 && await agreement.isVisible().catch(() => false)) await agreement.check();
  console.log('Credentials filled. Please complete the slider and click Login in the opened browser window.');
} else {
  await page.screenshot({ path: 'artifacts/auth-setup-failure.png', fullPage: true }).catch(() => {});
  await browser.close();
  throw new Error('Login form was not found. The page was not saved as authenticated.');
}

let authenticated = await loggedInContentVisible();
for (let i = 0; !authenticated && i < 180; i += 1) {
  await page.waitForTimeout(1_000);
  authenticated = await loggedInContentVisible();
}

if (!authenticated) {
  await page.screenshot({ path: 'artifacts/auth-setup-failure.png', fullPage: true }).catch(() => {});
  await browser.close();
  throw new Error('Login was not confirmed by visible chat or case content.');
}

await context.storageState({ path: 'playwright/.auth/science42.json' });
const sessionStorageState = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
await fs.writeFile(
  'playwright/.auth/science42-session.json',
  JSON.stringify(sessionStorageState, null, 2),
  'utf8'
);
console.log('Saved playwright/.auth/science42.json');
console.log(`Saved playwright/.auth/science42-session.json (${Object.keys(sessionStorageState).length} entries)`);
await browser.close();

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { cfg, requireEnv } from '../config/test-config.mjs';
import { getTargetUrl, getStorageStatePath } from '../config/project.mjs';

// Credentials via env only; never committed.
const testUser = process.env.SCIENCE42_USER;
const testPassword = process.env.SCIENCE42_PASSWORD;
requireEnv('SCIENCE42_USER', testUser);
requireEnv('SCIENCE42_PASSWORD', testPassword);

const baseUrl = getTargetUrl();
const storageState = getStorageStatePath();
const sessionStatePath = process.env.SCIENCE42_SESSION_STATE
  || path.join(path.dirname(storageState), 'science42-session.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(new URL(cfg.entryPath, baseUrl).href, { waitUntil: 'domcontentloaded' });
// Let the SPA finish rendering its authentication modal.
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
    page.locator('[role="dialog"] input[placeholder*="手机号"]'),
    page.locator('[role="dialog"] input[placeholder*="密码"]'),
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
    page.getByText('物理求解', { exact: true }),
    page.getByText('新建聊天', { exact: true }),
    page.locator('[class*="ActionCardPanel"]'),
    page.getByText('科学研究案例管理', { exact: true }),
    page.getByText('研究案例', { exact: true }),
    page.getByRole('button', { name: '新建案例', exact: true }),
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

for (let i = 0; i < 60 && !(username && loginPassword); i += 1) {
  username = await firstVisible(
    '#username, input[autocomplete="username"], input[placeholder*="手机号"], input[placeholder*="邮箱"]',
  );
  loginPassword = await firstVisible(
    '#password, input[type="password"], input[placeholder*="密码"]',
  );
  if (!(username && loginPassword) && !loginOpened) {
    const loginButton = await firstVisible('button:has-text("登录"), [role="button"]:has-text("登录")');
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
  console.log('已填入账号。请在浏览器中完成滑块验证并点击登录。');
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

await fs.mkdir(path.dirname(storageState), { recursive: true, mode: 0o700 });
await context.storageState({ path: storageState });
const sessionStorageState = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
await fs.writeFile(sessionStatePath, JSON.stringify(sessionStorageState, null, 2), 'utf8');
console.log(`已保存 ${storageState}`);
console.log(`已保存 ${sessionStatePath} (${Object.keys(sessionStorageState).length} entries)`);
console.log(`目标站 ${baseUrl}`);
await browser.close();

import { chromium } from '@playwright/test';
import { cfg, requireEnv } from '../config/test-config.mjs';

requireEnv('SCIENCE42_USER', cfg.user);
requireEnv('SCIENCE42_PASSWORD', cfg.password);
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
const baseUrl = process.env.SCIENCE42_BASE_URL || 'http://192.168.0.112:23191';
await page.goto(new URL(cfg.entryPath, baseUrl).href);
await page.locator(cfg.selectors.username).fill(cfg.user);
await page.locator(cfg.selectors.password).fill(cfg.password);
const agreement = page.locator('input[type="checkbox"]');
if (await agreement.count() === 1) await agreement.check();
console.log('请在打开的测试环境窗口中完成拖拽验证码并点击登录。完成后回到终端按 Enter。');
for (let i = 0; i < 120; i++) {
  const loginVisible = await page.locator(cfg.selectors.password).isVisible().catch(() => false);
  if (!loginVisible) break;
  await page.waitForTimeout(1000);
}
await context.storageState({ path: 'playwright/.auth/science42.json' });
await browser.close();
console.log('已保存 playwright/.auth/science42.json');

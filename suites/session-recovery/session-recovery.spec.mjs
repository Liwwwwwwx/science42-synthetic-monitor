import { test, expect } from '@playwright/test';
import { loginIfNeeded, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { cfg } from '../../shared/config/test-config.mjs';

test('SR-30 smoke: completed conversation survives reload', async ({ page }) => {
  await loginIfNeeded(page);
  const result = await sendAndMeasure(page, '会话恢复测试：只回答“通过”。');
  expect(result.status).toBe('completed');
  const before = await page.locator('main').innerText();
  await page.waitForTimeout(3_000);
  console.log(`SR-30 conversation URL before reload: ${page.url()}`);
  await page.reload();
  await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3_000);
  const after = await page.locator('main').innerText();
  expect(after).toContain('会话恢复测试');
  expect(after.length).toBeGreaterThanOrEqual(before.length * 0.8);
});

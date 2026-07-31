import { test, expect } from '@playwright/test';
import { loginIfNeeded, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { cfg } from '../../shared/config/test-config.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'session_recovery';

test('SR-30 smoke: completed conversation survives reload', async ({ page }) => {
  const startedAt = new Date();
  await loginIfNeeded(page);
  const sendStarted = Date.now();
  const result = await sendAndMeasure(page, '会话恢复测试：只回答“通过”。');
  expect(result.status).toBe('completed');
  const before = await page.locator('main').innerText();
  await page.waitForTimeout(3_000);
  console.log(`SR-30 conversation URL before reload: ${page.url()}`);
  const reloadStarted = Date.now();
  await page.reload();
  await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3_000);
  const after = await page.locator('main').innerText();
  const restoredText = after.includes('会话恢复测试');
  const lengthOk = after.length >= before.length * 0.8;
  expect(after).toContain('会话恢复测试');
  expect(after.length).toBeGreaterThanOrEqual(before.length * 0.8);

  await finishSuiteReport({
    suiteId: SUITE_ID,
    startedAt,
    checks: [
      {
        key: 'send_message',
        status: mapItemStatus(result.status),
        durationMs: result.finalMs || Date.now() - sendStarted,
        errorCode: result.status === 'completed' ? null : 'SEND_FAILED',
        message: '发送会话恢复测试消息',
      },
      {
        key: 'reload_restore',
        status: restoredText && lengthOk ? 'passed' : 'failed',
        durationMs: Date.now() - reloadStarted,
        errorCode: restoredText && lengthOk ? null : 'RESTORE_FAILED',
        message: '刷新后会话内容保留',
      },
    ],
  });
});

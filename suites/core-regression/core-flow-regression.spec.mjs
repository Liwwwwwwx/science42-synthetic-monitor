import { test, expect } from '@playwright/test';
import { cfg } from '../../shared/config/test-config.mjs';
import { loginIfNeeded, newConversation, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'core_regression';

test('CORE regression: login, send, stream, result, reload', async ({ page }, testInfo) => {
  const startedAt = new Date();
  test.setTimeout(120_000);
  await loginIfNeeded(page);
  await newConversation(page);

  // Single send + stream verification
  const result = await sendAndMeasure(page, 'What is 2+2? Reply with just the number.');
  const body = await page.locator('main').innerText().catch(() => '');
  const passed = result.status === 'completed' && /4/.test(body);

  // Reload — conversation should persist
  const before = await page.locator('main').innerText();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_000);
  const after = await page.locator('main').innerText();
  const restored = after.includes('2+2') || after === before;

  await finishSuiteReport({
    page, testInfo,
    suiteId: SUITE_ID,
    startedAt,
    checks: [
      { key: 'chat_stream', status: passed ? 'passed' : 'failed', durationMs: result.finalMs, errorCode: passed ? null : 'SEND_FAILED', message: '发送并接收流式回复' },
      { key: 'session_restore', status: restored ? 'passed' : 'failed', durationMs: 2000, errorCode: restored ? null : 'RESTORE_FAILED', message: '刷新后对话保留' },
    ],
  });

  expect(passed).toBe(true);
});

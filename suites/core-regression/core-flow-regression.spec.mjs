import { test, expect } from '@playwright/test';
import { cfg } from '../../shared/config/test-config.mjs';
import { loginIfNeeded, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';
import { getTargetUrl } from '../../shared/config/project.mjs';

const SUITE_ID = 'core_regression';

// Each case has a check on the full response text
const cases = [
  { id: 'long', question: '[CORE-long] Explain HTTP 504, its difference from client timeout, and give two troubleshooting steps in about 120 words.', check: text => text.length >= 100 && /504/.test(text) },
  { id: 'context_1', question: '[CORE-context-1] Remember this code word: ORANGE-42. Reply with ACK only.', check: text => /ACK/i.test(text) },
  { id: 'context_2', question: '[CORE-context-2] What code word did I ask you to remember? Reply with the exact code word.', check: text => /ORANGE-42/.test(text) },
];

test('CORE regression: login, send, stream, result, context, save and restore', async ({ page }, testInfo) => {
  const startedAt = new Date();
  test.setTimeout(600_000);
  await loginIfNeeded(page);

  const records = [];
  for (const item of cases) {
    const result = await sendAndMeasure(page, item.question);
    // Read full response from main for content validation
    const body = await page.locator('main').innerText().catch(() => '');
    const passed = result.status === 'completed' && item.check(body);
    records.push({
      ...item,
      passed,
      status: result.status,
      elapsedMs: result.finalMs,
      capturedAt: new Date().toISOString(),
    });
  }
  // Check context preserved (conversation reload)
  const before = await page.locator('main').innerText();
  const reloadStarted = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3_000);
  const after = await page.locator('main').innerText();
  const restored = after.includes('ORANGE-42');

  await finishSuiteReport({
    page, testInfo,
    suiteId: SUITE_ID,
    startedAt,
    checks: [
      ...records.map((r) => ({
        key: r.id,
        status: r.passed ? 'passed' : 'failed',
        durationMs: r.elapsedMs,
        errorCode: r.passed ? null : 'ASSERT_FAILED',
        message: r.question.slice(0, 500),
      })),
      {
        key: 'session_restore',
        status: restored ? 'passed' : 'failed',
        durationMs: Date.now() - reloadStarted,
        errorCode: restored ? null : 'RESTORE_FAILED',
        message: '刷新后上下文保留',
      },
    ],
  });

  expect(records.filter(r => r.passed)).toHaveLength(cases.length);
});

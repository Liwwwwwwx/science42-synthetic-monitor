import { test, expect } from '@playwright/test';
import questions from '../../shared/config/questions.json' with { type: 'json' };
import { loginIfNeeded, newConversation, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { cfg } from '../../shared/config/test-config.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'long_chat_s30b';

test('S-30B: 30 sequential questions in one conversation', async ({ page }, testInfo) => {
  const startedAt = new Date();
  await loginIfNeeded(page);
  await newConversation(page);
  const results = [];
  for (let i = 0; i < 30; i++) {
    const result = await sendAndMeasure(page, questions[i % questions.length]);
    results.push({ index: i + 1, ...result });
    expect(result.httpStatus, JSON.stringify(result)).toBe(200);
  }
  expect(results).toHaveLength(30);
  expect(results.filter(r => r.httpStatus === 200)).toHaveLength(30);
  await expect(page.locator(cfg.selectors.input)).toBeVisible();
  await testInfo.attach('s30b-results.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

  await finishSuiteReport({
    page, testInfo,
    suiteId: SUITE_ID,
    startedAt,
    checks: results.map((r) => ({
      key: `turn_${String(r.index).padStart(2, '0')}`,
      status: r.httpStatus === 200 ? 'passed' : mapItemStatus(r.status),
      durationMs: r.finalMs,
      errorCode: r.httpStatus === 200 ? null : 'HTTP_ERROR',
      message: r.question.slice(0, 500),
    })),
  });
});

import { test, expect } from '@playwright/test';
import { cfg } from '../../shared/config/test-config.mjs';
import questions from '../../shared/config/questions.json' with { type: 'json' };
import { loginIfNeeded, newConversation, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'smoke_s10';

test('S-10: fixed questions, one new conversation per task', async ({ page }, testInfo) => {
  const startedAt = new Date();
  await loginIfNeeded(page);
  const results = [];
  for (const question of questions) {
    await newConversation(page);
    const result = await sendAndMeasure(page, question);
    results.push(result);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.finalMs, JSON.stringify(result)).toBeLessThanOrEqual(cfg.maxTaskMs);
  }

  await testInfo.attach('s10-results.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });

  await finishSuiteReport({
    suiteId: SUITE_ID,
    startedAt,
    checks: results.map((r, i) => ({
      key: `q${String(i + 1).padStart(2, '0')}`,
      status: mapItemStatus(r.status),
      durationMs: r.finalMs,
      errorCode: r.status === 'completed' ? null : 'CHECK_FAILED',
      message: r.question.slice(0, 500),
    })),
  });
});

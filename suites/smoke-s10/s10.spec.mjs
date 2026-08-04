import { test, expect } from '@playwright/test';
import { cfg } from '../../shared/config/test-config.mjs';
import questions from '../../shared/config/questions.json' with { type: 'json' };
import { loginIfNeeded, newConversation, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'smoke_s10';

test('S-10: 10 fixed questions in one conversation', async ({ page }, testInfo) => {
  const startedAt = new Date();
  await loginIfNeeded(page);
  await newConversation(page);

  const results = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const r = await sendAndMeasure(page, q);
    results.push(r);
  }

  await testInfo.attach('s10-results.json', {
    body: JSON.stringify(results, null, 2), contentType: 'application/json',
  });

  // Always report, even if some failed
  await finishSuiteReport({
    suiteId: SUITE_ID, startedAt, page, testInfo,
    checks: results.map((r, i) => ({
      key: `q${String(i + 1).padStart(2, '0')}`,
      status: mapItemStatus(r.status),
      durationMs: r.finalMs,
      errorCode: r.status === 'completed' ? null : 'CHECK_FAILED',
      message: r.question.slice(0, 500),
    })),
  });

  // Assert last
  for (const r of results) {
    expect(r.status, `FAILED: ${r.question}`).toBe('completed');
  }
});

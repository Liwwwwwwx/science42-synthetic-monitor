import { test, expect } from '@playwright/test';
import { cfg } from '../../shared/config/test-config.mjs';
import questions from '../../shared/config/questions.json' with { type: 'json' };
import { loginIfNeeded, newConversation, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'smoke_s10';

test('S-10: fixed questions in one conversation', async ({ page }, testInfo) => {
  const startedAt = new Date();
  await loginIfNeeded(page);
  await newConversation(page);
  const results = [];
  // First message sets the conversation title
  const titleMsg = '[S-10] Science42 Smoke Test';
  const titleResult = await sendAndMeasure(page, titleMsg);
  expect(titleResult.status).toBe('completed');
  // Remaining 9 questions in the same conversation
  for (let i = 1; i < questions.length; i++) {
    const question = questions[i];
    const result = await sendAndMeasure(page, question);
    results.push(result);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.finalMs, JSON.stringify(result)).toBeLessThanOrEqual(cfg.maxTaskMs);
  }

  await testInfo.attach('s10-results.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });

  const checks = results.map((r, i) => ({
    key: `q${String(i + 2).padStart(2, '0')}`,
    status: mapItemStatus(r.status),
    durationMs: r.finalMs,
    errorCode: r.status === 'completed' ? null : 'CHECK_FAILED',
    message: r.question.slice(0, 500),
  }));
  await finishSuiteReport({ suiteId: SUITE_ID, startedAt, checks });
});

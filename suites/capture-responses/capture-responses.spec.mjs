import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import questions from '../../shared/config/questions.json' with { type: 'json' };
import { cfg } from '../../shared/config/test-config.mjs';
import { loginIfNeeded, newConversation } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'capture_responses';

test('capture S-10 response content in one conversation', async ({ page }, testInfo) => {
  const startedAt = new Date();
  test.setTimeout(900_000);
  await loginIfNeeded(page);
  await newConversation(page);

  // Title message
  const input = page.locator(cfg.selectors.input).last();
  await expect(input).toBeEnabled({ timeout: 15_000 });
  await input.fill('[Capture] Science42 响应抓取');
  await input.press('Enter');
  await page.waitForTimeout(2000);

  const records = [];
  for (const question of questions) {
    await expect(input).toBeEnabled({ timeout: 10_000 });
    const started = Date.now();
    await input.fill(question);
    await input.press('Enter');
    let prevLen = 0;
    let answerText = '';
    const deadline = Date.now() + cfg.maxTaskMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const full = await page.locator('main').innerText().catch(() => '');
      if (full.length > prevLen + 10) {
        answerText = full.slice(prevLen).trim();
        if (!/生成中|Generating/i.test(answerText.slice(-200))) break;
      }
      prevLen = full.length;
    }
    records.push({
      index: records.length + 1,
      question,
      answer: answerText,
      elapsedMs: Date.now() - started,
      status: answerText && !/失败|超时|failed/i.test(answerText) ? 'completed' : 'failed',
      capturedAt: new Date().toISOString(),
    });
  }

  await fs.mkdir('results/runs/capture_responses', { recursive: true });
  await fs.writeFile('results/runs/capture_responses/latest.json', JSON.stringify(records, null, 2), 'utf8');
  await testInfo.attach('response-content.json', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
  expect(records).toHaveLength(questions.length);

  await finishSuiteReport({
    page, testInfo,
    suiteId: SUITE_ID,
    startedAt,
    checks: records.map((r) => ({
      key: `q${String(r.index).padStart(2, '0')}`,
      status: mapItemStatus(r.status),
      durationMs: r.elapsedMs,
      errorCode: r.status === 'completed' ? null : 'CAPTURE_FAILED',
      message: r.question.slice(0, 500),
    })),
  });
});

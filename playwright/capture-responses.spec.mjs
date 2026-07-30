import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import questions from '../config/questions.json' with { type: 'json' };
import { cfg } from '../config/test-config.mjs';
import { loginIfNeeded, newConversation } from './helpers.mjs';

test('capture S-10 response content', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  await loginIfNeeded(page);
  const records = [];
  for (const question of questions) {
    const input = page.locator(cfg.selectors.input).last();
    await expect(input).toBeVisible();
    const started = Date.now();
    await input.fill(question);
    await input.press('Enter');
    let paragraphTexts = [];
    let answerText = '';
    const deadline = Date.now() + cfg.maxTaskMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      paragraphTexts = await page.locator('main p').allTextContents();
      const idx = paragraphTexts.lastIndexOf(question);
      answerText = idx >= 0 ? (paragraphTexts[idx + 1] || '').trim() : '';
      if (answerText && !/生成中|Generating/.test(answerText)) break;
    }
    records.push({
      index: records.length + 1,
      question,
      answer: answerText,
      elapsedMs: Date.now() - started,
      status: answerText && !/失败|超时|failed/i.test(answerText) ? 'completed' : 'failed',
      capturedAt: new Date().toISOString()
    });
  }
  await fs.writeFile('artifacts/response-content.json', JSON.stringify(records, null, 2), 'utf8');
  await testInfo.attach('response-content.json', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
  expect(records).toHaveLength(questions.length);
});

import { test, expect } from '@playwright/test';
import { cfg } from '../config/test-config.mjs';
import questions from '../config/questions.json' with { type: 'json' };
import { loginIfNeeded, newConversation, sendAndMeasure } from './helpers.mjs';

test('S-10: fixed questions, one new conversation per task', async ({ page }, testInfo) => {
  await loginIfNeeded(page);
  const results = [];
  for (const question of questions) {
    await newConversation(page);
    const result = await sendAndMeasure(page, question);
    results.push(result);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.finalMs, JSON.stringify(result)).toBeLessThanOrEqual(cfg.maxTaskMs);
  }
  await testInfo.attach('s10-results.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});

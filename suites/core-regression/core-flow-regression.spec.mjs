import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { cfg } from '../../shared/config/test-config.mjs';
import { loginIfNeeded } from '../../shared/lib/helpers.mjs';

const cases = [
  { id: 'calc', question: '[CORE-calc] Calculate 987654321 * 123456789. Output only the integer.', check: text => /121932631112635269/.test(text) },
  { id: 'json', question: '[CORE-json] Output only valid JSON: {"name":"Zhang San","age":18}', check: text => { try { const v = JSON.parse(text.replace(/^```json\s*|```$/g, '').trim()); return v.name === 'Zhang San' && v.age === 18; } catch { return false; } } },
  { id: 'list', question: '[CORE-list] List exactly three items: test, record, review.', check: text => ['test', 'record', 'review'].every(k => text.toLowerCase().includes(k)) },
  { id: 'long', question: '[CORE-long] Explain HTTP 504, its difference from client timeout, and give two troubleshooting steps in about 120 words.', check: text => text.length >= 100 && /504/.test(text) },
  { id: 'context-1', question: '[CORE-context-1] Remember this code word: ORANGE-42. Reply with ACK only.', check: text => /ACK/i.test(text) },
  { id: 'context-2', question: '[CORE-context-2] What code word did I ask you to remember? Reply with the exact code word.', check: text => /ORANGE-42/.test(text) }
];

async function answerFor(page, question) {
  const input = page.locator(cfg.selectors.input).last();
  const started = Date.now();
  const responses = [];
  const onResponse = response => {
    if (response.url().includes('/api/') && response.request().method() !== 'OPTIONS') responses.push({ url: response.url(), status: response.status(), atMs: Date.now() - started });
  };
  page.on('response', onResponse);
  await input.fill(question);
  await input.press('Enter');
  let answer = '';
  let lastMain = '';
  const deadline = Date.now() + cfg.maxTaskMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const paragraphs = await page.locator('main p').allTextContents();
    const index = paragraphs.lastIndexOf(question);
    answer = index >= 0 ? (paragraphs[index + 1] || '').trim() : '';
    lastMain = await page.locator('main').innerText().catch(() => '');
    const generating = /生成中|生成中|Generating/i.test(lastMain.slice(-500));
    if (answer && !generating) break;
  }
  page.off('response', onResponse);
  return { answer, elapsedMs: Date.now() - started, responses, timedOut: !answer };
}

test('CORE regression: login, send, stream, result, context, save and restore', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await loginIfNeeded(page);
  const records = [];
  for (const item of cases) {
    const observed = await answerFor(page, item.question);
    const passed = !observed.timedOut && item.check(observed.answer);
    records.push({ ...item, ...observed, passed, capturedAt: new Date().toISOString() });
  }
  const before = await page.locator('main').innerText();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3_000);
  const after = await page.locator('main').innerText();
  const restored = after.includes('[CORE-context-2]') && after.includes('ORANGE-42');
  const summary = { environment: process.env.SCIENCE42_BASE_URL || 'http://192.168.0.112:23191', records, beforeLength: before.length, afterLength: after.length, restored, completed: records.filter(r => r.passed).length, total: records.length };
  await fs.mkdir('results/runs/core_regression', { recursive: true });
  await fs.writeFile('results/runs/core_regression/latest.json', JSON.stringify(summary, null, 2), 'utf8');
  await testInfo.attach('core-flow-regression.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
  expect(records.filter(r => r.passed), JSON.stringify(summary)).toHaveLength(cases.length);
  expect(restored, JSON.stringify(summary)).toBeTruthy();
});

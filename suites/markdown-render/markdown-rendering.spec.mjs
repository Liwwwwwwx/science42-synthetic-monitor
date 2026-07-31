import { test, expect } from '@playwright/test';
import { loginIfNeeded, newConversation } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport } from '../../shared/report/index.mjs';

const SUITE_ID = 'markdown_render';
const MD = (sel) => `.markdown-body ${sel}, main ${sel}`;

const prompts = [
  {
    id: 'table',
    question: '用表格列出前 3 个化学元素：名称、符号、原子序数。用 Markdown 表格格式输出。',
    check: async (page) => {
      const table = page.locator(MD('table'));
      await expect(table.first()).toBeVisible({ timeout: 30_000 });
      const rows = table.locator('tr');
      await expect(rows).toHaveCount(4);
      const cells = await table.locator('td, th').allTextContents();
      return /氢|Hydrogen/.test(cells.join('|')) && /氦|Helium/.test(cells.join('|'));
    },
  },
  {
    id: 'code-block',
    question: '写一个 Python 的冒泡排序函数，用 Markdown 代码块包裹（```python ... ```）。',
    check: async (page) => {
      await page.locator('.code-block-header').first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
      const code = page.locator(`${MD('pre code')}, .code-block-content pre, .code-block-content code`);
      await expect(code.first()).toBeVisible({ timeout: 60_000 });
      const text = (await code.first().textContent()) || '';
      return /def/.test(text) && (/bubble|sort|for/i.test(text));
    },
  },
  {
    id: 'latex-inline',
    question: '二次方程 ax²+bx+c=0 的求根公式是什么？用 LaTeX 表达，写 $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$。',
    check: async (page) => {
      const math = page.locator(`${MD('.katex')}, ${MD('mjx-container')}, ${MD('math')}`);
      await expect(math.first()).toBeVisible({ timeout: 60_000 });
      const text = (await page.locator('main').textContent()) || '';
      return /frac|sqrt|±/.test(text);
    },
  },
  {
    id: 'bold-italic',
    question: '用 Markdown 回复：请用 **粗体** 写"重要"，用 *斜体* 写"提示"，用 ~~删除线~~ 写"过时"。',
    check: async (page) => {
      const root = page.locator('main');
      await expect(root.locator('strong, b').first()).toBeVisible({ timeout: 30_000 });
      await expect(root.locator('em, i').first()).toBeVisible({ timeout: 5_000 });
      return (await root.locator('del, s, strike').count()) > 0;
    },
  },
  {
    id: 'ordered-list',
    question: '用 Markdown 有序列表列出"软件测试的 4 个步骤"，每个步骤一行。',
    check: async (page) => {
      const ol = page.locator(MD('ol'));
      if (await ol.count() > 0) {
        await expect(ol.first()).toBeVisible({ timeout: 30_000 });
        return (await ol.locator('li').count()) >= 3;
      }
      const text = (await page.locator('main').innerText()) || '';
      return /\b[12]\.\s/.test(text) && /\b[34]\.\s/.test(text);
    },
  },
];

test('Markdown/LaTeX rendering: table, code, math, text-style', async ({ page }, testInfo) => {
  const startedAt = new Date();
  test.setTimeout(300_000);
  await loginIfNeeded(page);
  await newConversation(page);

  const results = [];
  // Title message for conversation
  const input = page.locator('textarea, [contenteditable]').last();
  await expect(input).toBeEnabled({ timeout: 15_000 });
  await input.fill('[Markdown] Science42 渲染测试');
  await input.press('Enter');
  await page.waitForTimeout(2000);

  for (const { id, question, check } of prompts) {
    const itemStarted = Date.now();
    await expect(input).toBeEnabled({ timeout: 10_000 });
    await input.fill(question);
    await input.press('Enter');

    let passed = false;
    let error = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        passed = await check(page);
        if (passed) break;
      } catch (e) {
        error = e.message?.slice(0, 200);
      }
      await page.waitForTimeout(500);
    }
    results.push({ id, question, passed, error, durationMs: Date.now() - itemStarted, capturedAt: new Date().toISOString() });
    console.log(`[render] ${id}: ${passed ? 'PASS' : 'FAIL'}${error ? ' — ' + error : ''}`);
  }

  await finishSuiteReport({
    page, testInfo,
    suiteId: SUITE_ID,
    startedAt,
    checks: results.map((r) => ({
      key: r.id.replace(/-/g, '_'),
      status: r.passed ? 'passed' : 'failed',
      durationMs: r.durationMs,
      errorCode: r.passed ? null : 'RENDER_FAILED',
      message: r.question.slice(0, 500),
    })),
  });

  const failed = results.filter(r => !r.passed);
  expect(failed, `Rendering failures: ${JSON.stringify(failed)}`).toHaveLength(0);
});

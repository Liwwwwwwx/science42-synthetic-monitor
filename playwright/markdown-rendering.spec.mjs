import { test, expect } from '@playwright/test';
import { loginIfNeeded, newConversation } from './helpers.mjs';

const prompts = [
  {
    id: 'table',
    question: '用表格列出前 3 个化学元素：名称、符号、原子序数。用 Markdown 表格格式输出。',
    check: async (page) => {
      const table = page.locator('main table');
      await expect(table.first()).toBeVisible({ timeout: 30_000 });
      const rows = table.locator('tr');
      await expect(rows).toHaveCount(4); // header + 3 rows
      const cells = await table.locator('td, th').allTextContents();
      return /氢|Hydrogen/.test(cells.join('|')) && /氦|Helium/.test(cells.join('|'));
    },
  },
  {
    id: 'code-block',
    question: '写一个 Python 的冒泡排序函数，用 Markdown 代码块包裹（```python ... ```）。',
    check: async (page) => {
      const code = page.locator('main pre code, main code[class*=\"language\"]');
      await expect(code.first()).toBeVisible({ timeout: 60_000 });
      const text = await code.first().textContent();
      return text.includes('def') && (text.includes('bubble') || text.includes('sort') || text.includes('for'));
    },
  },
  {
    id: 'latex-inline',
    question: '二次方程 ax²+bx+c=0 的求根公式是什么？用 LaTeX 表达，写 $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$。',
    check: async (page) => {
      // KaTeX renders as <span class="katex">, MathJax as <mjx-container>
      const math = page.locator('main .katex, main mjx-container, main math');
      await expect(math.first()).toBeVisible({ timeout: 60_000 });
      const text = await page.locator('main').textContent();
      return /\\\\frac|\\\\sqrt|\\\\pm|frac|sqrt|±/.test(text || '');
    },
  },
  {
    id: 'bold-italic',
    question: '用 Markdown 回复：请用 **粗体** 写"重要"，用 *斜体* 写"提示"，用 ~~删除线~~ 写"过时"。',
    check: async (page) => {
      const main = page.locator('main');
      await expect(main.locator('strong, b').first()).toBeVisible({ timeout: 30_000 });
      const em = main.locator('em, i').first();
      await expect(em).toBeVisible({ timeout: 5_000 });
      const strike = main.locator('del, s, strike').first();
      return await strike.count() > 0;
    },
  },
  {
    id: 'ordered-list',
    question: '用 Markdown 有序列表列出"软件测试的 4 个步骤"，每个步骤一行。',
    check: async (page) => {
      const list = page.locator('main ol');
      await expect(list.first()).toBeVisible({ timeout: 30_000 });
      const items = list.locator('li');
      const count = await items.count();
      return count >= 3;
    },
  },
];

test('Markdown/LaTeX rendering: table, code, math, text-style', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await loginIfNeeded(page);

  const results = [];
  for (const { id, question, check } of prompts) {
    await newConversation(page);
    const input = page.locator('.chat-input textarea, [contenteditable], textarea[placeholder]').last();
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
      await page.waitForTimeout(2000);
    }

    results.push({ id, question, passed, error, capturedAt: new Date().toISOString() });
    console.log(`[render] ${id}: ${passed ? 'PASS' : 'FAIL'}${error ? ' — ' + error : ''}`);
  }

  await testInfo.attach('render-results.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });

  const failed = results.filter(r => !r.passed);
  expect(failed, `Rendering failures: ${JSON.stringify(failed)}`).toHaveLength(0);
});

import { test, expect } from '@playwright/test';
import { loginIfNeeded, newConversation } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport } from '../../shared/report/index.mjs';

const SUITE_ID = 'markdown_render';

const prompts = [
  {
    id: 'table',
    question: '用表格列出前 3 个化学元素：名称、符号、原子序数。用 Markdown 表格格式输出。',
    check: async (_page, answer) => {
      // 不取页面第一张表：首页和历史消息可能各自带有无关表格。
      // 仅认可同时包含题目内容且具有表头和三行数据的响应表格。
      return answer.locator('table').evaluateAll((tables) => tables.some((table) => {
        const text = table.textContent || '';
        const rowCount = table.querySelectorAll('tr').length;
        return rowCount >= 4
          && /氢|Hydrogen/.test(text)
          && /氦|Helium/.test(text)
          && /锂|Lithium/.test(text);
      }));
    },
  },
  {
    id: 'code-block',
    question: '写一个 Python 的冒泡排序函数，用 Markdown 代码块包裹（```python ... ```）。',
    check: async (_page, answer) => {
      await answer.locator('.code-block-header').first().click({ timeout: 5_000 }).catch(() => {});
      const code = answer.locator('pre code, .code-block-content pre, .code-block-content code');
      if (await code.count() === 0) return false;
      const text = (await code.first().textContent()) || '';
      return /def/.test(text) && (/bubble|sort|for/i.test(text));
    },
  },
  {
    id: 'latex-inline',
    question: '二次方程 ax²+bx+c=0 的求根公式是什么？用 LaTeX 表达，写 $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$。',
    check: async (_page, answer) => {
      const math = answer.locator('.katex, mjx-container, math');
      if (await math.count() === 0) return false;
      const text = (await answer.textContent()) || '';
      return /−b|±|sqrt|frac/.test(text);
    },
  },
  {
    id: 'bold-italic',
    question: '用 Markdown 回复：请用 **粗体** 写"重要"，用 *斜体* 写"提示"，用 ~~删除线~~ 写"过时"。',
    check: async (_page, answer) => {
      return (await answer.locator('strong, b').count()) > 0
        && (await answer.locator('em, i').count()) > 0
        && (await answer.locator('del, s, strike').count()) > 0;
    },
  },
  {
    id: 'ordered-list',
    question: '用 Markdown 有序列表列出"软件测试的 4 个步骤"，每个步骤一行。',
    check: async (_page, answer) => {
      const ol = answer.locator('ol');
      if (await ol.count() > 0) {
        return (await ol.locator('li').count()) >= 3;
      }
      const text = (await answer.innerText()) || '';
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
  const input = page.locator('textarea, [contenteditable]').last();
  await expect(input).toBeEnabled({ timeout: 15_000 });
  // 平台为每条助手消息提供稳定的数据角色，避免依赖头像文案或 CSS Modules 类名。
  const assistantReplies = page.locator('[data-role="assistant"]');

  for (const { id, question, check } of prompts) {
    const itemStarted = Date.now();
    await expect(input).toBeEnabled({ timeout: 10_000 });
    const replyCountBeforeSend = await assistantReplies.count();
    await input.fill(question);
    await input.press('Enter');

    let passed = false;
    let error = null;
    let receivedAssistantReply = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const replyCount = await assistantReplies.count();
        if (replyCount <= replyCountBeforeSend) {
          await page.waitForTimeout(500);
          continue;
        }
        receivedAssistantReply = true;
        const answer = assistantReplies.nth(replyCount - 1);
        passed = await check(page, answer);
        if (passed) break;
      } catch (e) {
        error = e.message?.slice(0, 200);
      }
      await page.waitForTimeout(500);
    }
    const failureReason = passed
      ? null
      : (receivedAssistantReply
        ? '已收到本次助手回复，但未渲染出预期格式。'
        : '45 秒内未收到本次提问的助手回复。');
    results.push({
      id,
      question,
      passed,
      error,
      errorCode: passed ? null : (receivedAssistantReply ? 'RENDER_FAILED' : 'NO_ASSISTANT_REPLY'),
      failureReason,
      durationMs: Date.now() - itemStarted,
      capturedAt: new Date().toISOString(),
    });
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
      errorCode: r.errorCode,
      message: r.passed ? r.question.slice(0, 500) : `${r.question}\n失败原因：${r.failureReason}`,
    })),
  });

  const failed = results.filter(r => !r.passed);
  expect(failed, `Rendering failures: ${JSON.stringify(failed)}`).toHaveLength(0);
});

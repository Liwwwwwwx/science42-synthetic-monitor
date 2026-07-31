import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';

// 批量点击正式站点聊天页中的案例卡片 Run，并保存每个案例的页面输出。
// 账号登录和滑块验证必须由人工完成；脚本不读取或绕过验证码数据。
const CATEGORY = (process.env.CASE_CATEGORY || 'physics').toLowerCase();
const RUN_TIMEOUT = Number(process.env.CASE_RUN_TIMEOUT_MS || 120_000);
const CASE_LIMIT = Number(process.env.CASE_LIMIT || 0);
const DRY_RUN = process.env.CASE_DRY_RUN === '1';
const CHAT_PATH = '/#/chat';
const SESSION_STATE_PATH = process.env.SCIENCE42_SESSION_STATE || 'playwright/.auth/science42-session.json';

const CATEGORY_LABEL = {
  physics: '物理求解',
  math: '数学建模',
  material: '材料计算'
}[CATEGORY] || '物理求解';

function failurePattern(text) {
  return /运行失败|执行失败|任务失败|failed|error|错误|异常|504|50[0-9]/i.test(text);
}

function successPattern(text) {
  return /运行完成|执行完成|任务完成|已完成|completed|success|成功|结果返回|输出结果/i.test(text);
}

const FAILURE_RE = /运行失败|执行失败|任务失败|failed|error|错误|异常|504|50[0-9]/i;
const SUCCESS_RE = /运行完成|执行完成|任务完成|completed|success|成功|结果返回|输出结果|执行完成/i;

function patternCount(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length;
}

// The production UI writes Run completion into the chat transcript.
const EXECUTION_COMPLETE_RE = /项目[\s\S]{0,160}执行完成/i;

async function chooseCategory(page) {
  const loginOverlay = page.locator(
    'div[class*="login-section"], [role="dialog"] input[placeholder*="\u624b\u673a"], [role="dialog"] input[placeholder*="\u5bc6\u7801"]'
  );
  for (let i = 0; i < await loginOverlay.count(); i += 1) {
    if (await loginOverlay.nth(i).isVisible().catch(() => false)) return false;
  }
  const actions = page.locator('div[class*="chat-action"]');
  // The production chat shell can render the sidebar first and hydrate the
  // case panel later. Keep polling long enough for that asynchronous load.
  for (let retry = 0; retry < 90; retry += 1) {
    const count = await actions.count();
    for (let i = 0; i < count; i += 1) {
      const action = actions.nth(i);
      if ((await action.innerText().catch(() => '')).trim() === CATEGORY_LABEL && await action.isVisible().catch(() => false)) {
        try {
          await action.click({ timeout: 3_000 });
        } catch {
          return false;
        }
        await page.waitForTimeout(2_000);
        return true;
      }
    }
    const fallbackActions = page.locator('main').getByText(CATEGORY_LABEL, { exact: true });
    for (let i = await fallbackActions.count() - 1; i >= 0; i -= 1) {
      const action = fallbackActions.nth(i);
      if (await action.isVisible().catch(() => false)) {
        try {
          await action.click({ timeout: 3_000 });
          await page.waitForTimeout(2_000);
          return true;
        } catch {
          return false;
        }
      }
    }
    await page.waitForTimeout(1_000);
  }
  return false;
}

function caseCards(page) {
  return page.locator(
    'div[class*="ActionCardPanel"][class*="card"], div[class*="CaseCard_card"]'
  ).filter({ has: page.locator('button, [title], h3') });
}

async function cardByTitle(page, title) {
  const labels = page.locator('span[class*="label"][title]');
  for (let i = 0; i < await labels.count(); i += 1) {
    const label = labels.nth(i);
    if (await label.getAttribute('title').catch(() => '') !== title) continue;
    const card = label.locator(
      'xpath=ancestor::div[contains(@class,"ActionCardPanel") or contains(@class,"CaseCard_card")][1]'
    );
    if (await card.isVisible().catch(() => false)) return card;
  }
  return null;
}

async function waitForCaseCards(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const cards = caseCards(page);
    for (let i = 0; i < await cards.count(); i += 1) {
      if (await cards.nth(i).locator('span[class*="label"][title], h3, [title]').count() > 0) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function collectOutput(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const output = await page.locator('pre, [class*="output" i], [class*="result" i], [role="status"]')
    .allTextContents().catch(() => []);
  return {
    output: output.filter(Boolean).join('\n').slice(-12_000),
    pageTail: body.slice(-8_000)
  };
}

async function cardInputs(card) {
  const inputs = await card.locator('input, textarea, [role="spinbutton"]').evaluateAll(elements => elements.map((element, index) => ({
    index,
    type: element.getAttribute('type'),
    value: element.value ?? element.getAttribute('aria-valuenow') ?? '',
    name: element.getAttribute('name') || element.getAttribute('placeholder') || ''
  }))).catch(() => []);
  return inputs;
}

async function restoreSessionStorage(page) {
  try {
    const state = JSON.parse(await fs.readFile(SESSION_STATE_PATH, 'utf8'));
    await page.addInitScript(entries => {
      for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
    }, state);
  } catch {
    // Cookie/localStorage-only sessions do not need sessionStorage restoration.
  }
}

test(`批量执行${CATEGORY_LABEL}案例并保存Run输出`, async ({ page }, testInfo) => {
  test.setTimeout(Math.max(180_000, RUN_TIMEOUT * 2));
  await restoreSessionStorage(page);
  // The production SPA can keep background resources open indefinitely.
  // The test only needs the initial DOM, not the browser's full load event.
  let navigationError = '';
  try {
    await page.goto(CHAT_PATH, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }
  await page.waitForTimeout(5_000);

  const selected = await chooseCategory(page);
  if (selected) await waitForCaseCards(page);
  const cards = caseCards(page);
  const cardCount = await cards.count();
  const titles = [];
  for (let i = 0; i < cardCount; i += 1) {
    const titleLocator = cards.nth(i).locator('span[class*="label"][title], h3, [title]').first();
    const title = await titleLocator.getAttribute('title').catch(() => '')
      || (await titleLocator.innerText().catch(() => '')).trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  if (CASE_LIMIT > 0) titles.splice(CASE_LIMIT);
  console.log(`[batch] selected=${selected} cards=${cardCount} cases=${titles.length}`);

  const results = [];
  if (!selected || titles.length === 0) {
    results.push({
      category: CATEGORY,
      title: '',
      status: 'BLOCKED',
      reason: selected ? '已选择分类，但未找到案例卡片' : `未找到“${CATEGORY_LABEL}”分类入口`,
      ...(await collectOutput(page))
    });
  }

  for (let index = 0; index < titles.length; index += 1) {
    const title = titles[index];
    console.log(`[case ${index + 1}/${titles.length}] ${title} - starting`);
    const result = {
      index: index + 1,
      category: CATEGORY,
      title,
      startedAt: new Date().toISOString(),
      status: 'BLOCKED',
      durationMs: null,
      inputs: [],
      output: '',
      pageTail: '',
      reason: ''
    };
    const started = Date.now();
    try {
      const card = await cardByTitle(page, title);
      if (!card || !(await card.isVisible().catch(() => false))) {
        result.reason = '案例卡片在执行前不可见';
      } else {
        result.inputs = await cardInputs(card);
        const run = card.getByRole('button', { name: 'Run', exact: true });
        if (await run.count() === 0) {
          result.reason = '案例卡片未提供可定位的 Run 按钮';
        } else if (DRY_RUN) {
          result.status = 'DISCOVERED';
          result.reason = '盘点模式：未点击 Run';
        } else {
          await run.scrollIntoViewIfNeeded();
          const before = await collectOutput(page);
          const beforeText = `${before.output}\n${before.pageTail}`;
          await run.click();
          result.status = 'RUNNING';
          try {
            await expect.poll(async () => {
              const current = await collectOutput(page);
              const currentText = `${current.output}\n${current.pageTail}`;
              const changed = currentText !== beforeText;
              const newFailure = patternCount(currentText, FAILURE_RE) > patternCount(beforeText, FAILURE_RE);
              const newSuccess = patternCount(currentText, SUCCESS_RE) > patternCount(beforeText, SUCCESS_RE);
              const executionComplete = EXECUTION_COMPLETE_RE.test(currentText);
              return Boolean(changed && (executionComplete || newFailure || newSuccess));
            }, { timeout: RUN_TIMEOUT, intervals: [500, 1_000, 2_000] }).toBeTruthy();
          } catch {
            // A poll timeout is recorded below as TIMEOUT after capturing the page output.
          }
          const current = await collectOutput(page);
          result.output = current.output;
          result.pageTail = current.pageTail;
          const currentText = `${result.output}\n${result.pageTail}`;
          const newFailure = patternCount(currentText, FAILURE_RE) > patternCount(beforeText, FAILURE_RE);
          const newSuccess = patternCount(currentText, SUCCESS_RE) > patternCount(beforeText, SUCCESS_RE);
          const changed = currentText !== beforeText;
          const executionComplete = EXECUTION_COMPLETE_RE.test(currentText);
          result.status = newFailure && !executionComplete ? 'FAILED' : (newSuccess || (changed && executionComplete)) ? 'PASSED' : 'TIMEOUT';
        }
      }
    } catch (error) {
      result.status = 'FAILED';
      result.reason = error instanceof Error ? error.message : String(error);
      Object.assign(result, await collectOutput(page));
    }
    result.durationMs = Date.now() - started;
    result.finishedAt = new Date().toISOString();
    results.push(result);
    console.log(`[case ${index + 1}/${titles.length}] ${title} - ${result.status} (${result.durationMs} ms)`);
  }

  const report = {
    capturedAt: new Date().toISOString(),
    environment: page.url(),
    category: CATEGORY,
    categoryLabel: CATEGORY_LABEL,
    dryRun: DRY_RUN,
    selectedCategory: selected,
    navigationError,
    cardCount,
    matchedCount: titles.length,
    results
  };
  const outputDir = path.join('artifacts', 'internal-cases', CATEGORY);
  await fs.mkdir(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `batch-case-results-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8');
  await testInfo.attach('batch-case-results.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  const unsuccessful = results.filter(result => ['FAILED', 'TIMEOUT'].includes(result.status));
  expect(unsuccessful, '至少一个案例未成功完成 Run').toHaveLength(0);
  // 阻塞必须让 CI 失败，避免“未登录/未找到案例”被误报为测试通过。
  expect(selected && titles.length > 0, '未成功加载分类案例；请确认登录状态和页面入口').toBeTruthy();
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { checkKey, finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';
import { ensureMonitoringConversation } from '../../shared/lib/helpers.mjs';

// 批量点击 SCIENCE42_BASE_URL 指向目标的聊天页案例卡 Run，并保存每个案例的页面输出。
// 账号登录和滑块验证必须由人工完成；脚本不读取或绕过验证码数据。
const CATEGORY = (process.env.CASE_CATEGORY || 'physics').toLowerCase();
// 数据建模（CAD 装配/三维网格）任务实测正常完成需 5-10 分钟；通用 300s 会截断正常执行。
const DEFAULT_RUN_TIMEOUT_MS = CATEGORY === 'data' ? 660_000 : 300_000;
const RUN_TIMEOUT = Number(process.env.CASE_RUN_TIMEOUT_MS || DEFAULT_RUN_TIMEOUT_MS);
// 页面、分类与案例卡加载属于前置条件；不能占用物理任务的 5 分钟求解预算。
const PREPARE_TIMEOUT_MS = Number(process.env.CASE_PREPARE_TIMEOUT_MS || 90_000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.CASE_NAVIGATION_TIMEOUT_MS || 30_000);
const CASE_LIMIT = Number(process.env.CASE_LIMIT || 0);
const CASE_TITLE = process.env.CASE_TITLE || '';
const CASE_CATALOG_INDEX = Number(process.env.CASE_CATALOG_INDEX || 0);
const DRY_RUN = process.env.CASE_DRY_RUN === '1';
const CHAT_PATH = '/#/chat';
const SESSION_STATE_PATH = process.env.SCIENCE42_SESSION_STATE || 'shared/auth/.auth/science42-session.json';
// 上报套件 ID 按分类推导：材料/数据案例若打 batch_cases（物理）标签，
// 会错误地出现在前端「物理案例」套件视图里（曾实测材料案例跑到物理分类下）。
const SUITE_ID = CATEGORY === 'data' ? 'data_cases' : CATEGORY === 'material' ? 'material_cases' : 'batch_cases';

const CATEGORY_LABEL = {
  physics: '物理求解',
  math: '数学建模',
  material: '材料计算',
  data: '数据建模'
}[CATEGORY] || '物理求解';
const IS_PHYSICS_CASE = CATEGORY === 'physics';
// 会话池：同账号并发时每个案例占用一个专用会话，避免在同一会话内互相串扰。
// 槽位由 run-cases.mjs 按 --pool=N 计算（--pool 默认 3，即产品端实测并发容量），经环境变量传入。
const CONVERSATION_SLOT = Number(process.env.CASE_CONVERSATION_SLOT || 0);
const CONVERSATION_PREFIX = { physics: '物理案例', math: '数学案例', material: '材料案例', data: '数据案例' }[CATEGORY] || '物理案例';
const IS_DATA_CASE = CATEGORY === 'data';
const IS_MATERIAL_CASE = CATEGORY === 'material';

// 材料计算（category=model + waterlily 入口）专属验收：以真实 Run 输出定标。
// 抽样证据（2026-08-04）：
//  - Run 后会出现「追问与补充」对话框（上传文件 / 继续(60s 自动继续) / 停 止），
//    默认选项为「停 止」；点击后任务按当前输入继续，不中断已流式输出的答案。
//  - Profile B（检索综合型，如液冷工质/固态电解质）：中文检索项 → 论文检索进度/检索概览
//    → 文献证据 → 综合回答；「综合回答」为验收约束字段。
//  - Profile A（文本分析型，如 3D 打印材料/陶瓷基板，目录未命中或仅需求分析）：
//    Round 1 + 材料分析章节（材料名称核对/已入库性质/本轮建议 或 需求表）+ 追问推荐，无检索字段。
//  - 当前材料案例均为文本/检索输出，未见 MaterialsPNG/GLB/STL 结构化产物；产物检查按卡片实际能力记录。
// 材料「追问与补充」对话框的停止按钮：必须锚定「停 止」完整文本，
// 子串匹配会误点「停止生成」等其它按钮，提前截断回答导致材料输出不完整。
const MATERIAL_DIALOG_STOP_RE = /^停\s*止$/;
const MATERIAL_ZH_SEARCH_RE = /中文检索项/;
const MATERIAL_RETRIEVAL_PROGRESS_RE = /论文检索进度|检索概览|检索结果重排|文献检索/;
const MATERIAL_COMPREHENSIVE_RE = /综合回答/;
const MATERIAL_ZHUITUI_RE = /追问推荐\s*[→>]?/;
const MATERIAL_ANALYSIS_RE = /材料名称核对|已入库性质|本轮建议|核心材料需求|候选材料|需求与瓶颈的关联/;
// 综合回答区段的“候选/性能结论”信号：只作用于「综合回答」之后的文本，避免初始确认语误匹配。
const MATERIAL_CONCLUSION_RE = /候选|结论|方案|性能|指标|建议|推荐/;

// 数据建模（dataAnalytics）专属验收：CAD 组装与建模任务必须出现的流程文案。
// 以真实 Run 输出定标：规划 → 底层代码 → 几何实体，缺任何一段都视为流程不完整。
const DATA_REQUIRED_PHRASES = [
  'CAD 组装与建模任务',
  '正在构思装配结构规划',
  '规划已交付，开始编写底层代码',
  '正在生成几何实体，请稍候',
];
// stl 文件产物信号：文本引用文件名/链接、STL_VIEWER 内嵌标记或 3D 查看器徽标
const STL_RE = /\.stl(?:[?#]|$)|<<<STL_VIEWER:|STL 模型|>STL<|STL_VIEWER/i;

// 失败信号只认明确的失败文案（配合新增计数对比，历史转录残留不会误触发）。
// 不能含 error/504/50x 等：案例描述与历史对话里的 Max Error、HTTP 504、参数 2500 等会误匹配。
const FAILURE_RE = /运行失败|执行失败|任务失败|failed/i;
// 成功信号只认产品固定的完成文案（写入聊天转录），避免详情页文本误匹配。
// The production UI writes Run completion into the chat transcript.
const EXECUTION_COMPLETE_RE = /项目[\s\S]{0,160}执行完成/i;
const STREAMING_RE = /生成中|正在生成|Generating/i;

// ── 通用验收标准 ─────────────────────────────────────────────
// 1 分钟无任务输出 = 服务响应超时（数据建模新会话首次任务首输出可能 1-3 分钟；
// 材料计算任务串行排队，批量场景下靠后的案例首输出会被前面任务挤占，同样放宽到 3 分钟）
const RESPONSE_TIMEOUT_MS = Number(process.env.CASE_RESPONSE_TIMEOUT_MS
  || (CATEGORY === 'data' || CATEGORY === 'material' ? 180_000 : 60_000));
// 提问后首输出延迟上限（本地 PINN 实测常 25-35s，默认 45s；可用 CASE_FIRST_REPLY_LIMIT_MS 覆盖。
// 数据建模/材料计算新会话首次任务首输出可能 1-3 分钟，放宽到 180s）
const FIRST_REPLY_LIMIT_MS = Number(process.env.CASE_FIRST_REPLY_LIMIT_MS
  || (CATEGORY === 'data' || CATEGORY === 'material' ? 180_000 : 45_000));
// 团队服务不可用 = 服务挂了
const SERVICE_DOWN_RE = /团队服务不可用|服务暂时不可用|服务不可用|服务异常/i;
// Step 标题（任务流程章节）
const STEP_RE = /Step\s*(\d+)[\s.、:：]/gi;
// PNG 输出标记（文本引用或图片元素）
const PNG_RE = /\.png\b|data:image\/png|!\[[^\]]*\]\([^)]*\.png/i;
// 物理求解案例的结果规范：任务流程必须出现的章节。
const REQUIRED_STEPS = [1, 2, 3, 4, 5, 6];
// 任务已开始的早期信号（只认「生成中」类实时状态；Step/完成文案会在历史转录里残留，不能扫整页）
const EARLY_OUTPUT_RE = /生成中|正在生成|Generating/i;

function isDataCaseComplete(dataPhrasesSeen, stlSeen) {
  return DATA_REQUIRED_PHRASES.every((phrase) => dataPhrasesSeen.has(phrase)) && stlSeen;
}

/**
 * 从案例标题提取可在自然语言回复中出现的领域词。
 * 不要求回复复述完整标题；例如“1U立方星多物理场（热-结构）耦合求解”
 * 只要命中“立方星/结构/耦合”等多个领域词即可。
 */
function extractKeywords(title) {
  const normalized = String(title || '').replace(/[（）()\-—：:，,。；;、\s]/g, '');
  const latin = normalized.match(/[A-Za-z][A-Za-z0-9]{1,}/g) || [];
  const chineseBigrams = [];
  for (const phrase of normalized.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < phrase.length - 1; i += 1) chineseBigrams.push(phrase.slice(i, i + 2));
  }
  const generic = new Set(['求解', '仿真', '模型', '物理', '场景', '案例']);
  return [...new Set([...latin, ...chineseBigrams])].filter((term) => !generic.has(term));
}

function matchCaseKeywords(title, text) {
  const terms = extractKeywords(title);
  const hits = terms.filter((term) => text.includes(term));
  const requiredHits = terms.length >= 2 ? 2 : 1;
  return { terms, hits, requiredHits, matched: hits.length >= requiredHits };
}

/** 把 Playwright 超时堆栈收成运维可读的一句话。 */
function stripBlockedReason(reason) {
  const raw = String(reason || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!raw) return '案例未能启动';
  if (/登录|login|立即注册|LoginExpired|401/i.test(raw)) return '未登录或登录态已失效，请重新 auth:setup';
  if (/未找到指定案例|卡片/.test(raw)) return '未找到案例卡片（面板未加载或列表懒加载未滚到）';
  if (/分类入口|物理求解|数学建模/.test(raw)) return '未找到分类入口，请确认页面与登录状态';
  if (/Timeout|timeout|等待/.test(raw)) {
    if (/物理案例专用会话|自动化测试/.test(raw)) return '物理案例专用会话未就绪（页面加载超时）';
    return '页面等待超时，案例未能启动';
  }
  // 去掉 Call log 与 locator 细节
  return raw
    .replace(/Call log:[\s\S]*$/i, '')
    .replace(/locator\.[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || '案例未能启动';
}

/** 检测页面代码块归属：Step 5 / Step 6 区域是否各含代码块。 */
async function codeBlockSteps(root) {
  const result = { s5: false, s6: false };
  try {
    const blocks = root.locator('[class*="code-block"], pre, [class*="CodeBlock"]');
    const n = await blocks.count();
    for (let i = 0; i < Math.min(n, 80); i += 1) {
      const ctx = await blocks.nth(i).evaluate((node) => {
        let p = node.parentElement;
        let text = '';
        for (let k = 0; k < 10 && p; k += 1) {
          text = p.textContent || '';
          if (text.includes('Step')) break;
          p = p.parentElement;
        }
        return text;
      }).catch(() => '');
      if (/Step\s*5[\s.、:：]/.test(ctx)) result.s5 = true;
      if (/Step\s*6[\s.、:：]/.test(ctx)) result.s6 = true;
    }
  } catch {
    // 代码块检测失败不影响整体流程
  }
  return result;
}

function assistantMessages(page) {
  return page.locator('[data-role="assistant"]');
}

async function assistantSnapshot(page) {
  const messages = assistantMessages(page);
  const snapshot = new Set();
  const count = await messages.count();
  for (let index = 0; index < count; index += 1) {
    const message = messages.nth(index);
    const content = message.locator('[data-message-id]').last();
    const id = await content.getAttribute('data-message-id').catch(() => null);
    const text = (await content.innerText().catch(() => '')) || await message.innerText().catch(() => '');
    // 同时保留 id 和文本：新建会话会替换整段 DOM，单独比较数量或 index 都会误判。
    snapshot.add(`${id || index}\u0000${text.trim()}`);
  }
  return snapshot;
}

function isInitialAssistantGreeting(text) {
  return /秋月白为您服务|The Answer to Life, Universe, and Everything/i.test(text)
    && !EXECUTION_COMPLETE_RE.test(text);
}

/**
 * 点击 Run 后会话 DOM 会重渲染（React 重挂载消息列表，data-message-id 整体变化），
 * 点击前拍的快照会全部失效。等消息集合连续两次快照一致（重渲染完成）后返回最终快照，
 * 作为 latestNewAssistant 的基线；若重渲染持续（最多等 timeoutMs），返回最后一次快照。
 * 用于替代“点击前拍快照”，避免历史消息被 latestNewAssistant 误判为“新增”。
 */
async function waitForAssistantSettled(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = await assistantSnapshot(page);
  await page.waitForTimeout(500);
  while (Date.now() < deadline) {
    const current = await assistantSnapshot(page);
    if (current.size === previous.size && [...current].every((value) => previous.has(value))) {
      return current;
    }
    previous = current;
    await page.waitForTimeout(500);
  }
  return previous;
}

/**
 * 只观察点击 Run 后出现或更新的 assistant 消息，不能再用数量增长判断：
 * 当前会话可复用，服务端也可能复用已有的消息容器进行流式更新。
 */
async function latestNewAssistant(page, beforeSnapshot) {
  const messages = assistantMessages(page);
  for (let index = await messages.count() - 1; index >= 0; index -= 1) {
    const message = messages.nth(index);
    const content = message.locator('[data-message-id]').last();
    const id = await content.getAttribute('data-message-id').catch(() => null);
    const text = (await content.innerText().catch(() => '')) || await message.innerText().catch(() => '');
    const normalizedText = text.trim();
    if (!normalizedText || beforeSnapshot.has(`${id || index}\u0000${normalizedText}`)) continue;
    // 初始欢迎语不是本次案例输出。
    if (isInitialAssistantGreeting(normalizedText)) continue;
    return { message, content, text: normalizedText, count: await messages.count() };
  }
  return null;
}

async function chooseCategory(page, timeoutMs) {
  const loginOverlay = page.locator(
    'div[class*="login-section"], [role="dialog"] input[placeholder*="\u624b\u673a"], [role="dialog"] input[placeholder*="\u5bc6\u7801"]'
  );
  for (let i = 0; i < await loginOverlay.count(); i += 1) {
    if (await loginOverlay.nth(i).isVisible().catch(() => false)) return false;
  }
  const actions = page.locator('div[class*="chat-action"]');
  // The production chat shell can render the sidebar first and hydrate the
  // case panel later. Keep polling long enough for that asynchronous load.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (let retry = 0; Date.now() < deadline; retry += 1) {
    const count = await actions.count();
    for (let i = 0; i < count; i += 1) {
      const action = actions.nth(i);
      if ((await action.innerText().catch(() => '')).trim() === CATEGORY_LABEL && await action.isVisible().catch(() => false)) {
        if (/selected/i.test(await action.getAttribute('class').catch(() => '') || '')) return true;
        try {
          await action.click({ timeout: 3_000 });
        } catch {
          continue;
        }
        await page.waitForTimeout(2_000);
        return true;
      }
    }
    // 当前线上聊天页没有稳定的 <main> 容器；从全页候选中倒序选择，优先命中底部输入栏动作。
    const fallbackActions = page.getByText(CATEGORY_LABEL, { exact: true });
    for (let i = await fallbackActions.count() - 1; i >= 0; i -= 1) {
      const action = fallbackActions.nth(i);
      if (await action.isVisible().catch(() => false)) {
        try {
          await action.click({ timeout: 3_000 });
          await page.waitForTimeout(2_000);
          return true;
        } catch {
          continue;
        }
      }
    }
    await page.waitForTimeout(1_000);
  }
  return false;
}

function caseCards(page) {
  // 卡片容器 class 会随编译变化，且内部所有元素 class 都带 ActionCardPanel 前缀，
  // 无法用 contains(@class) 区分。标题 span（__label，卡片直接子元素）是最稳定的锚点。
  return page
    .locator('div[class*="ActionCardPanel"] > span[class*="label"]')
    .locator('xpath=ancestor::div[contains(@class,"ActionCardPanel")][1]');
}

/**
 * 新版 Science42 会记住案例面板的折叠状态。分类按钮即使可见、可点击，
 * 折叠状态下也不会挂载 cardList，因此必须先展开面板再等待案例卡片。
 */
async function ensureCasePanelExpanded(page, timeoutMs = 10_000) {
  const timeout = Math.max(1, timeoutMs);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const labels = page.getByText('搜索案例', { exact: true });
    for (let index = await labels.count() - 1; index >= 0; index -= 1) {
      const searchLabel = labels.nth(index);
      if (!(await searchLabel.isVisible().catch(() => false))) continue;

      const panel = searchLabel.locator(
        'xpath=ancestor::div[contains(@class,"ActionCardPanel") and contains(@class,"panel")][1]'
      );
      const cardList = panel.locator('div[class*="cardList"]').first();
      if (await cardList.isVisible().catch(() => false)) return true;

      const toggle = panel.locator('div[class*="collapseIcon"]').first();
      if (!(await toggle.isVisible().catch(() => false))) continue;
      const remaining = Math.max(1, deadline - Date.now());
      try {
        await toggle.click({ timeout: Math.min(remaining, 5_000) });
      } catch {
        continue;
      }
      return cardList.isVisible({ timeout: remaining }).catch(() => false);
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function cardByTitle(page, title, timeoutMs = 20_000) {
  // 案例列表可能懒加载（服务端忙时只渲染视口附近卡片），
  // 找不到时滚动列表容器触发加载，最多重试 6 轮。
  const list = page.locator('div[class*="scrollTrack"], div[class*="cardList"]').first();
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 6 && Date.now() < deadline; attempt += 1) {
    const labels = page.locator('span[class*="label"][title]');
    for (let i = 0; i < await labels.count(); i += 1) {
      const label = labels.nth(i);
      if (await label.getAttribute('title', { timeout: 2_000 }).catch(() => '') !== title) continue;
      const card = label.locator(
        'xpath=ancestor::div[contains(@class,"ActionCardPanel") or contains(@class,"CaseCard_card")][1]'
      );
      if (await card.isVisible().catch(() => false)) return card;
    }
    // 未找到：滚动到底触发加载下一批卡片
    // 空骨架屏时列表容器不存在；Locator.evaluate 的默认 30s 等待会把 6 次重试拖成数分钟。
    // 这里使用短超时，并始终受 cardByTitle 的总预算约束。
    const remaining = Math.max(1, deadline - Date.now());
    await list.evaluate(
      (el) => { el.scrollTop = el.scrollHeight; },
      undefined,
      { timeout: Math.min(1_500, remaining) }
    ).catch(() => {});
    await page.waitForTimeout(1_500);
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
    // 完成文案「项目…执行完成」位于任务转录中间位置，8000 字符截断会漏掉
    //（长案例 Step 1-6 输出就占满了）；扩大到 32K 覆盖完整任务区。
    pageTail: body.slice(-32_000)
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
  const suiteStartedAt = new Date();
  // 全局超时覆盖前置加载 + 单卡求解 + 落盘/上报缓冲，避免某个 locator 无限拖住任务。
  test.setTimeout(Math.max(180_000, PREPARE_TIMEOUT_MS + RUN_TIMEOUT + 60_000));
  await restoreSessionStorage(page);
  // The production SPA can keep background resources open indefinitely.
  // The test only needs the initial DOM, not the browser's full load event.
  let navigationError = '';
  try {
    await page.goto(CHAT_PATH, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }
  if (!navigationError) {
    try {
      // 会话按分类隔离：数据建模任务（CAD 装配/网格）与物理案例混用同一会话时，
      // 失败历史会残留并让服务端直接拒绝下一轮 Run。
      // 并发时（CASE_CONVERSATION_SLOT>0）改用槽位专用会话（物理案例-N/数据案例-N），
      // 每个并发案例独占一个会话，互不串扰；切换失败则整卡 BLOCKED，不静默回退共用会话。
      // 材料计算也使用独立会话：与物理案例混用会让物理历史（如 Step 文案）污染材料验收，
      // 且失败历史残留会拒绝下一轮 Run。
      const conversationTitle = CONVERSATION_SLOT > 0
        ? `${CONVERSATION_PREFIX}-${CONVERSATION_SLOT}`
        : (IS_DATA_CASE ? '【自动化测试】数据建模' : IS_MATERIAL_CASE ? '【自动化测试】材料计算' : '【自动化测试】物理案例');
      const conversation = await ensureMonitoringConversation(page, conversationTitle);
      // 并发池模式（槽位会话）：既未新建也未选中目标会话时，说明列表不可见且当前不在目标会话，
      // 两个并发进程可能静默落到同一会话，池隔离失效。轮询等待列表渲染后重试，仍失败 → 整卡 BLOCKED。
      if (CONVERSATION_SLOT > 0 && !conversation.created && !conversation.selected) {
        const listDeadline = Date.now() + 15_000;
        let confirmed = false;
        while (Date.now() < listDeadline && !confirmed) {
          await page.waitForTimeout(1_000);
          const retry = await ensureMonitoringConversation(page, conversationTitle);
          confirmed = retry.created || retry.selected;
        }
        if (!confirmed) throw new Error(`专用会话「${conversationTitle}」列表不可见且无法选中`);
      }
    } catch (error) {
      navigationError = `${CATEGORY_LABEL}专用会话未就绪：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!navigationError) await page.waitForTimeout(Math.min(5_000, PREPARE_TIMEOUT_MS));
  // 专用会话的创建/恢复不属于案例面板加载预算；首次创建可能等待一次 AI 回复。
  const prepareDeadline = Date.now() + PREPARE_TIMEOUT_MS;

  let selected = false;
  let panelExpanded = false;
  let cardsReady = false;
  let prepareError = '';
  let cardCount = 0;
  const titles = [];
  try {
    if (!navigationError) selected = await chooseCategory(page, prepareDeadline - Date.now());
    if (selected) panelExpanded = await ensureCasePanelExpanded(page, Math.max(0, prepareDeadline - Date.now()));
    if (selected && panelExpanded) cardsReady = await waitForCaseCards(page, Math.max(0, prepareDeadline - Date.now()));
    if (selected && !cardsReady && Date.now() < prepareDeadline) {
      // 分类已选中后不能再次点击同一分类（会切换面板状态）；这里只继续等待展开与卡片加载。
      console.log('[batch] 卡片未加载，继续等待面板展开与分类卡片…');
      if (!panelExpanded) panelExpanded = await ensureCasePanelExpanded(page, prepareDeadline - Date.now());
      if (selected && panelExpanded) cardsReady = await waitForCaseCards(page, Math.max(0, prepareDeadline - Date.now()));
    }
    const cards = caseCards(page);
    cardCount = await cards.count();

    // 单案例模式：CASE_TITLE 指定精确案例名，跳过全量标题收集（一个进程只跑一个案例，
    // 可用 xargs -P 并行跑多个不同案例，互不影响）。未指定时走全量/限量收集。
    if (CASE_TITLE && selected && cardsReady) {
      titles.push(CASE_TITLE);
    } else {
      for (let i = 0; i < cardCount; i += 1) {
        const titleLocator = cards.nth(i).locator('span[class*="label"], h3').first();
        const title = await titleLocator.getAttribute('title', { timeout: 2_000 }).catch(() => '')
          || (await titleLocator.innerText({ timeout: 2_000 }).catch(() => '')).trim();
        if (title && !titles.includes(title)) titles.push(title);
      }
      if (CASE_LIMIT > 0) titles.splice(CASE_LIMIT);
    }
  } catch (error) {
    // 前置准备异常（页面崩溃/定位器报错等）不能直接抛出：否则 report 不会落盘，
    // 运行记录「什么都不保留」。这里兜底为 BLOCKED，保证结果文件与上报仍然生成。
    prepareError = error instanceof Error ? error.message : String(error);
    console.log(`[batch] 前置准备异常（${prepareError}），按 BLOCKED 记录`);
    selected = false;
    panelExpanded = false;
    cardsReady = false;
  }
  console.log(`[batch] selected=${selected} panelExpanded=${panelExpanded} cards=${cardCount} cases=${titles.length}${CASE_TITLE ? ` (single: ${CASE_TITLE})` : ''}`);
  // 单进程全量跑多个案例时，按案例数放大全局超时：
  // 固定 450s 只够 1 个案例（前置 90s + 单案例 300s + 缓冲），7 个材料案例会掐断后续任务。
  if (titles.length > 1) {
    const perCaseBudget = RUN_TIMEOUT + 60_000;
    testInfo.setTimeout(PREPARE_TIMEOUT_MS + titles.length * perCaseBudget + 60_000);
  }

  const results = [];
  if (!selected || !cardsReady || titles.length === 0) {
    const blockedReason = prepareError
      ? `前置准备异常：${prepareError}`
      : navigationError
        ? `聊天页加载失败：${navigationError}`
        : selected && !panelExpanded
          ? '分类已选择，但案例面板无法展开'
          : selected ? '分类已选择，但案例卡片在前置加载时限内未就绪' : `未找到“${CATEGORY_LABEL}”分类入口`;
    results.push({
      category: CATEGORY,
      title: '',
      status: 'BLOCKED',
      reason: blockedReason,
      ...(await collectOutput(page))
    });
    // BLOCKED 也必须输出标准结算行（带 reason）：
    // run-cases.mjs 从 `[case 1/1]` 行解析状态与原因，缺行时结算行退化为
    // `→ FAILED`（原因丢失），后端任务日志弹窗只见 FAILED 无失败原因。
    console.log(`[case 1/1] 未执行 - BLOCKED (0 ms)${blockedReason ? ` reason=${blockedReason}` : ''}`);
  }

  for (let index = 0; selected && cardsReady && index < titles.length; index += 1) {
    const title = titles[index];
    console.log(`[case ${index + 1}/${titles.length}] ${title} - starting`);
    const result = {
      index: index + 1,
      catalogIndex: CASE_CATALOG_INDEX || null,
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
      // 上一个案例 Run 后面板可能重新折叠（产品会记住折叠状态），
      // 先确保面板展开再按标题找下一张卡片，否则后续案例全部 BLOCKED。
      if (index > 0) {
        await ensureCasePanelExpanded(page, 15_000);
      }
      let card = await cardByTitle(page, title);
      if (!card || !(await card.isVisible().catch(() => false))) {
        // 面板可能不是“折叠”而是整个卸载（产品在 Run 后把视图重置回聊天列表，
        // 连「搜索案例」标题都不存在）。ensureCasePanelExpanded 只能处理折叠。
        // 刷新页面重新走“选择分类 → 展开面板 → 找卡片”完整流程，最多 2 轮，
        // 仍失败才 BLOCKED。曾实测：批量第 3 个案例起全部“案例卡片在执行前不可见”。
        console.log(`[case ${index + 1}] 卡片未找到，刷新页面并重新选择分类后重试…`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(3_000);
        for (let retry = 0; retry < 2 && !card; retry += 1) {
          const reselected = await chooseCategory(page, 15_000);
          const reexpanded = reselected && await ensureCasePanelExpanded(page, 15_000);
          if (reexpanded) card = await cardByTitle(page, title, 15_000);
          if (!card) await page.waitForTimeout(2_000);
        }
      }
      if (!card || !(await card.isVisible().catch(() => false))) {
        result.reason = CASE_TITLE ? `未找到指定案例：${CASE_TITLE}` : '案例卡片在执行前不可见';
      } else {
        result.inputs = await cardInputs(card);
        let run = card.getByRole('button', { name: 'Run', exact: true });
        if (await run.count() === 0) {
          result.reason = '案例卡片未提供可定位的 Run 按钮';
        } else if (DRY_RUN) {
          result.status = 'DISCOVERED';
          result.reason = '盘点模式：未点击 Run';
        } else {
          // 点击 Run：显式超时 + 失败重试。之前这里没有超时保护，按钮被遮挡/不可点时
          // click 会一直等到批量 test 超时（曾实测 24 分钟空转）；重试前重新展开面板
          // 并重找卡片（Run 后面板可能折叠导致按钮不可点）。
          let clicked = false;
          let clickError = null;
          const t0 = Date.now(); // 首输出计时从首次点击尝试开始（含重试与重渲染等待）
          for (let attempt = 0; attempt < 2 && !clicked; attempt += 1) {
            if (attempt > 0) {
              await ensureCasePanelExpanded(page, 15_000);
              const refreshed = await cardByTitle(page, title);
              if (refreshed && (await refreshed.isVisible().catch(() => false))) {
                run = refreshed.getByRole('button', { name: 'Run', exact: true });
              }
            }
            try {
              await run.scrollIntoViewIfNeeded({ timeout: 8_000 });
              await run.click({ timeout: 15_000 });
              clicked = true;
            } catch (error) {
              clickError = error instanceof Error ? error : new Error(String(error));
            }
          }
          if (!clicked) {
            result.reason = `Run 按钮点击失败（已重试）：${clickError?.message.split('\n')[0] || '未知错误'}`;
          } else {
            // 点击成功后，会话 DOM 会重渲染（data-message-id 整体变化），点击前拍的
            // assistantBefore 快照全部失效 → 历史消息会被 latestNewAssistant 误判为
            // “新增”（曾实测 4 秒假通过：首输出 237ms、材料信号全来自历史消息）。
            // 先等重渲染稳定（连续两次快照一致或最多 8s），再以稳定后的快照为基线。
            const assistantBefore = await waitForAssistantSettled(page, 8_000);
            result.status = 'RUNNING';

          // ── 验收数据采集轮询 ────────────────────────────
          let firstOutputMs = null;   // 点 Run 到首次输出的延迟
          let serviceDown = false;    // 团队服务不可用
          let stallDetected = false;  // 60s 无输出
          const stepsSeen = new Set();
          let pngSeen = false;
          const dataPhrasesSeen = new Set();
          let stlSeen = false;
          let dataComplete = false;
          let newFailure = false;
          let newComplete = false;
          // 材料计算：追问与补充对话框 + Profile 字段
          let materialDialogSeen = false;
          let materialDialogDismissed = false;
          let materialZhSearchSeen = false;
          let materialRetrievalProgressSeen = false;
          let materialComprehensiveSeen = false;
          let materialZhuituiSeen = false;
          let materialAnalysisSeen = false;
          let materialDone = false;
          let materialProducts = [];
          // 本次 Run 实际出现完成信号（综合回答 或 追问推荐+分析章节）的消息文本。
          // 会话重渲染后 latestNewAssistant 可能因消息 id 变化把历史消息误判为“新增”，
          // 用该文本作为材料验收的权威文本，避免最终快照被历史消息覆盖。
          let materialPeakText = '';
          // latestNewAssistant 连续返回 null 的轮次：回复稳定后 DOM 重渲染会短暂无消息，
          // 材料信号齐全时按此提前收尾，避免 60s 无输出误判 stall。
          let nullRounds = 0;
          let assistant = null;
          let assistantText = '';
          let previousAssistantText = '';
          let stableRounds = 0;
          let genericComplete = false;
          // 材料计算：最近一次有输出消息的时间（用于“距上次输出超过 60s”的 stall 判据）
          let lastAssistantUpdateMs = null;
          // 材料计算：「综合回答」标题首次出现时的文本长度。检索综合型的回答是流式输出，
          // 标题先出现、正文随后才写；仅凭 stableRounds 会在标题刚出现、正文未输出时
          // 就提前判定完成（曾实测：PCB 案例「综合回答 | 基于」即被截断 → NO_MATERIAL_CONCLUSION）。
          // 完成判定要求综合回答之后至少有 200 字符正文，避免空标题假完成。
          let comprehensiveAtLen = -1;
          // 材料完成信号：Profile B=综合回答；Profile A=分析章节+追问推荐
          const materialSignals = () => materialComprehensiveSeen || (materialZhuituiSeen && materialAnalysisSeen);

          const deadline = t0 + RUN_TIMEOUT;
          while (Date.now() < deadline) {
            const now = Date.now();
            // 材料计算：Run 后会出现「追问与补充」对话框，默认选「停 止」后任务继续完成。
            // 对话框是页面悬浮层（按钮只在弹层存在），与聊天转录中的历史文案无关。
            if (IS_MATERIAL_CASE && !materialDialogDismissed) {
              const stopBtn = page.locator('button').filter({ hasText: MATERIAL_DIALOG_STOP_RE }).last();
              if (await stopBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
                materialDialogSeen = true;
                await stopBtn.click({ timeout: 2_000 }).catch(() => {});
                if (!(await stopBtn.isVisible({ timeout: 1_000 }).catch(() => false))) {
                  materialDialogDismissed = true;
                }
              }
            }
            const current = await latestNewAssistant(page, assistantBefore);
            const pageText = (await page.locator('body').innerText().catch(() => '')).slice(-8_000);
            // 服务不可用 → 立即失败。只认“本次 Run 新增的 assistant 消息”，不扫整个 body：
            // 会话历史里残留的失败文案（如上一案例的服务不可用）会连锁污染后续案例
            //（曾实测：案例 A 服务不可用后，案例 B 仅 1.2s 就误判 SERVICE_DOWN）。
            // 服务端不可用时回复本身就是一条新 assistant 消息，用 current.text 判定足够。
            // 无新增消息时不再回退扫 body（历史残留会误报），交由下方 60s/180s 无输出逻辑判定。
            if (current && current.text.trim() && SERVICE_DOWN_RE.test(current.text.slice(-4_000))) {
              serviceDown = true;
              break;
            }

            // 首输出：优先认早期信号（生成中 / Step 1），其次认新 assistant 文案
            if (firstOutputMs === null) {
              if (EARLY_OUTPUT_RE.test(pageText) || (current && current.text.trim() && !isInitialAssistantGreeting(current.text))) {
                firstOutputMs = now - t0;
              }
            }

            if (!current || !current.text.trim()) {
              nullRounds += 1;
              // 材料计算：完成信号已齐全，只是 DOM 重渲染导致暂时取不到消息 → 视为已完成。
              if (IS_MATERIAL_CASE && materialSignals() && nullRounds >= 3 && !STREAMING_RE.test(assistantText || '')) {
                materialDone = true;
                break;
              }
              // 材料计算：60s 无输出的判据是“距上次有输出超过 60s”，不是“点击后 60s 内的任意空轮”。
              // 检索综合型回答可能流式输出 1-2 分钟，中间空轮不应截断仍在执行的正常任务。
              if (IS_MATERIAL_CASE) {
                const noOutputYet = lastAssistantUpdateMs === null && now - t0 > RESPONSE_TIMEOUT_MS;
                const outputStalled = lastAssistantUpdateMs !== null && now - lastAssistantUpdateMs > RESPONSE_TIMEOUT_MS;
                if (noOutputYet || outputStalled) { stallDetected = true; break; }
              } else if (now - t0 > RESPONSE_TIMEOUT_MS) {
                stallDetected = true;
                break;
              }
              // 前 30s 用更密轮询，减少首输出测量误差
              await page.waitForTimeout(now - t0 < 30_000 ? 500 : 1_500);
              continue;
            }

            nullRounds = 0;
            lastAssistantUpdateMs = now;
            assistant = current;
            assistantText = current.text;

            if (firstOutputMs === null) firstOutputMs = now - t0;
            stableRounds = assistantText === previousAssistantText ? stableRounds + 1 : 0;
            previousAssistantText = assistantText;

            newFailure = FAILURE_RE.test(assistantText);
            newComplete = EXECUTION_COMPLETE_RE.test(assistantText);
            genericComplete = newComplete || (!STREAMING_RE.test(assistantText) && stableRounds >= 2);

            if (IS_PHYSICS_CASE) {
              for (const m of assistantText.matchAll(STEP_RE)) stepsSeen.add(Number(m[1]));
              if (PNG_RE.test(assistantText)) pngSeen = true;
            }
            if (IS_DATA_CASE) {
              for (const phrase of DATA_REQUIRED_PHRASES) {
                if (assistantText.includes(phrase)) dataPhrasesSeen.add(phrase);
              }
              if (STL_RE.test(assistantText)) stlSeen = true;
            }
            if (IS_MATERIAL_CASE) {
              if (MATERIAL_ZH_SEARCH_RE.test(assistantText)) materialZhSearchSeen = true;
              if (MATERIAL_RETRIEVAL_PROGRESS_RE.test(assistantText)) materialRetrievalProgressSeen = true;
              if (MATERIAL_COMPREHENSIVE_RE.test(assistantText)) materialComprehensiveSeen = true;
              if (MATERIAL_ZHUITUI_RE.test(assistantText)) materialZhuituiSeen = true;
              if (MATERIAL_ANALYSIS_RE.test(assistantText)) materialAnalysisSeen = true;
              // 「综合回答」标题首次出现时记录位置：检索综合型的正文是流式输出的，
              // 标题先出现、正文随后才写，仅凭 stableRounds 会在正文未输出时提前收尾。
              if (MATERIAL_COMPREHENSIVE_RE.test(assistantText) && comprehensiveAtLen === -1) {
                comprehensiveAtLen = assistantText.length;
              }
              // 只记录“当前文本自身含完成信号”的版本，历史消息（无信号）不会覆盖真实材料回答。
              const curComplete = MATERIAL_COMPREHENSIVE_RE.test(assistantText)
                || (MATERIAL_ZHUITUI_RE.test(assistantText) && MATERIAL_ANALYSIS_RE.test(assistantText));
              if (curComplete && assistantText.length > materialPeakText.length) materialPeakText = assistantText;
            }
            // 数据建模：先吸收本轮新增流程文案与 STL，再判断完成。
            // 否则最终产物在截止轮出现时，会留下“流程/STL 通过、完成失败”的矛盾结果。
            dataComplete = IS_DATA_CASE ? isDataCaseComplete(dataPhrasesSeen, stlSeen) : false;
            // 材料计算：回复稳定（非流式中）且出现完成信号才算结束。
            // Profile B=综合回答出现；Profile A=分析章节+追问推荐出现。
            // 不能用通用 stableRounds 提前 break：检索流程中间会出现十几秒的停顿，
            // 停顿后还会继续流式输出（中文检索项/检索概览/综合回答）。
            // 综合回答后必须再有 ≥200 字符正文才算完成，否则「综合回答」空标题即被截断
            //（曾实测：PCB 案例 stableRounds=2 时正文只有「基于」两字 → NO_MATERIAL_CONCLUSION）。
            const materialBodyWritten = comprehensiveAtLen === -1
              || assistantText.length - comprehensiveAtLen >= 200;
            materialDone = IS_MATERIAL_CASE
              ? !STREAMING_RE.test(assistantText) && (stableRounds >= 2 || nullRounds >= 3)
                && materialSignals() && materialBodyWritten
              : false;
            if (newFailure || (IS_PHYSICS_CASE ? newComplete : IS_DATA_CASE ? dataComplete : IS_MATERIAL_CASE ? materialDone : genericComplete)) break;
            await page.waitForTimeout(now - t0 < 30_000 ? 500 : 1_500);
          }

          // 最终快照与补采
          const current = await collectOutput(page);
          result.output = current.output;
          result.pageTail = current.pageTail;
          assistant = assistant || await latestNewAssistant(page, assistantBefore);
          assistantText = assistant?.text || assistantText;
          // 材料计算：以本次 Run 出现完成信号的消息文本为准（防历史消息覆盖）。
          if (IS_MATERIAL_CASE && materialPeakText) assistantText = materialPeakText;
          if (assistantText) {
            for (const m of assistantText.matchAll(STEP_RE)) stepsSeen.add(Number(m[1]));
            if (PNG_RE.test(assistantText)) pngSeen = true;
            newFailure = FAILURE_RE.test(assistantText);
            newComplete = EXECUTION_COMPLETE_RE.test(assistantText);
            genericComplete = newComplete || (!STREAMING_RE.test(assistantText) && stableRounds >= 2);
            if (IS_DATA_CASE) {
              for (const phrase of DATA_REQUIRED_PHRASES) {
                if (assistantText.includes(phrase)) dataPhrasesSeen.add(phrase);
              }
              if (STL_RE.test(assistantText)) stlSeen = true;
              dataComplete = isDataCaseComplete(dataPhrasesSeen, stlSeen);
            }
            if (IS_MATERIAL_CASE) {
              if (MATERIAL_ZH_SEARCH_RE.test(assistantText)) materialZhSearchSeen = true;
              if (MATERIAL_RETRIEVAL_PROGRESS_RE.test(assistantText)) materialRetrievalProgressSeen = true;
              if (MATERIAL_COMPREHENSIVE_RE.test(assistantText)) materialComprehensiveSeen = true;
              if (MATERIAL_ZHUITUI_RE.test(assistantText)) materialZhuituiSeen = true;
              if (MATERIAL_ANALYSIS_RE.test(assistantText)) materialAnalysisSeen = true;
              // 最终快照同样要求「综合回答」正文 ≥200 字符才视为完成（与轮询内判定一致）。
              if (MATERIAL_COMPREHENSIVE_RE.test(assistantText) && comprehensiveAtLen === -1) {
                comprehensiveAtLen = assistantText.length;
              }
              const finalBodyWritten = comprehensiveAtLen === -1
                || assistantText.length - comprehensiveAtLen >= 200;
              materialDone = !STREAMING_RE.test(assistantText) && (stableRounds >= 2 || nullRounds >= 3)
                && materialSignals() && finalBodyWritten;
            }
          }
          result.assistantText = assistantText.slice(-12_000);

          // 深度物理验收只看本次新增 assistant 消息，绝不把案例卡自身图片算作任务产物。
          if (IS_PHYSICS_CASE && assistant && !pngSeen) {
            pngSeen = await assistant.content.locator('img[src*=".png"], img[src*="data:image/png"]')
              .count().then((n) => n > 0).catch(() => false);
          }
          // 数据建模：stl 产物可能以 STL 查看器组件（canvas/徽标）或 .stl 链接呈现，DOM 兜底检测
          if (IS_DATA_CASE && assistant && !stlSeen) {
            stlSeen = await assistant.content.locator('a[href*=".stl"], img[src*=".stl"], [class*="stl" i], [aria-label*="STL"], [title*=".stl"]')
              .count().then((n) => n > 0).catch(() => false);
          }
          // DOM 兜底发现 STL 后也必须同步完成状态，避免检查项彼此矛盾。
          if (IS_DATA_CASE) dataComplete = isDataCaseComplete(dataPhrasesSeen, stlSeen);
          // 材料计算：结构化产物按卡片实际能力记录（查看器按钮/文件引用），只认本次新增消息内的产物，
          // 会话历史里的 3D 查看器（如数据建模的 STL）不能算作材料案例产物。
          if (IS_MATERIAL_CASE && assistant) {
            materialProducts = await assistant.content.evaluate((root) => {
              const hrefs = [...root.querySelectorAll('a[href], img[src]')].map((el) => el.href || el.src || '');
              const viewers = [...root.querySelectorAll('button')]
                .filter((b) => /保存到资产|重置视角|引用文件/.test(b.textContent || '')).length;
              const types = [];
              if (hrefs.some((h) => /\.(stl|glb|gltf)([?#]|$)/i.test(h)) || viewers > 0) types.push('3D查看器/GLB-STL');
              if (hrefs.some((h) => /\.png([?#]|$)/i.test(h)) || /data:image\/png/.test(root.textContent || '')) types.push('PNG');
              return types;
            }).catch(() => []);
          }
          const codeBlocks = IS_PHYSICS_CASE && assistant ? await codeBlockSteps(assistant.content) : { s5: false, s6: false };
          const materialProfile = IS_MATERIAL_CASE
            ? (materialComprehensiveSeen ? 'retrieval' : (materialZhuituiSeen && materialAnalysisSeen ? 'analysis' : null))
            : null;

          // ── 验收判定 ────────────────────────────────────
          const itemChecks = [];
          const pass = (key, msg, dur) => itemChecks.push({ key, status: 'passed', durationMs: dur || 0, message: msg });
          const fail = (key, code, msg, dur) => itemChecks.push({ key, status: 'failed', durationMs: dur || 0, errorCode: code, message: msg });
          const skip = (key, msg) => itemChecks.push({ key, status: 'error', durationMs: 0, errorCode: 'PREREQUISITE_FAILED', message: msg });

          // 1) 服务可用
          if (serviceDown) {
            fail('service', 'SERVICE_DOWN', '团队服务不可用：服务挂了');
          } else {
            pass('service', '团队服务可用');
          }

          // 2) 首输出延迟 / 60s 无输出=响应超时
          if (serviceDown) {
            skip('first_output', '服务不可用，未进入执行');
          } else if (firstOutputMs === null) {
            fail('first_output', stallDetected ? 'RESPONSE_TIMEOUT' : 'NO_OUTPUT', `${RESPONSE_TIMEOUT_MS / 1000}s 内无任务输出`);
          } else if (firstOutputMs <= FIRST_REPLY_LIMIT_MS) {
            pass('first_output', `首输出 ${firstOutputMs}ms（≤${FIRST_REPLY_LIMIT_MS / 1000}s）`, firstOutputMs);
          } else {
            fail('first_output', 'SLOW_FIRST_OUTPUT', `首输出 ${firstOutputMs}ms 超过 ${FIRST_REPLY_LIMIT_MS / 1000}s`, firstOutputMs);
          }

          // 所有分类都先验证最基本闭环：本次 Run 必须产生或更新一条有内容的 assistant 回复。
          if (serviceDown) {
            skip('assistant_reply', '服务不可用，未进入执行');
          } else if (assistantText.trim()) {
            pass('assistant_reply', '本次 Run 已产生或更新 assistant 回复');
          } else {
            fail('assistant_reply', 'NO_ASSISTANT_REPLY', '未检测到本次 Run 的 assistant 回复');
          }

          // 以下是物理求解案例的结果规范，不套用到数学建模或材料计算。
          if (IS_PHYSICS_CASE) {
            if (serviceDown) {
              skip('steps', '服务不可用，未进入执行');
            } else {
              const missing = REQUIRED_STEPS.filter((n) => !stepsSeen.has(n));
              if (missing.length === 0) {
                pass('steps', 'Step 1-6 完整出现');
              } else {
                fail('steps', 'MISSING_STEP', `缺少 Step ${missing.join(',')}；已见: ${[...stepsSeen].sort().join(',')}`);
              }
            }

            if (serviceDown) {
              skip('codeblocks', '服务不可用，未进入执行');
            } else if (codeBlocks.s5 && codeBlocks.s6) {
              pass('codeblocks', 'Step 5 与 Step 6 各含代码块');
            } else {
              fail('codeblocks', 'MISSING_CODE_BLOCK', `Step5 代码块:${codeBlocks.s5 ? '有' : '无'}，Step6 代码块:${codeBlocks.s6 ? '有' : '无'}`);
            }

            if (serviceDown) {
              skip('png', '服务不可用，未进入执行');
            } else if (pngSeen) {
              pass('png', '本次回复中包含 PNG 图');
            } else {
              fail('png', 'NO_PNG', '本次回复中未检测到 PNG 图片');
            }

            if (serviceDown) {
              skip('keyword', '服务不可用，未进入执行');
            } else {
              const keywordMatch = matchCaseKeywords(title, assistantText);
              if (keywordMatch.matched) {
                pass('keyword', `本次回复命中领域词：${keywordMatch.hits.join('/')}`);
              } else {
                fail('keyword', 'KEYWORD_MISMATCH', `本次回复领域词不足（命中 ${keywordMatch.hits.join('/') || '无'}；至少需 ${keywordMatch.requiredHits} 项）`);
              }
            }
          }

          // 数据建模（dataAnalytics）专属验收：CAD 组装流程文案完整 + stl 文件产物。
          // 不继承物理的 Step 1-6 / PNG 要求；流程文案按真实 Run 定标。
          if (IS_DATA_CASE) {
            if (serviceDown) {
              skip('cad_flow', '服务不可用，未进入执行');
            } else {
              const missing = DATA_REQUIRED_PHRASES.filter((phrase) => !dataPhrasesSeen.has(phrase));
              if (missing.length === 0) {
                pass('cad_flow', 'CAD 组装与建模流程文案完整出现');
              } else {
                fail('cad_flow', 'MISSING_CAD_PHRASE', `缺少流程文案：${missing.join('；')}`);
              }
            }

            if (serviceDown) {
              skip('stl_file', '服务不可用，未进入执行');
            } else if (stlSeen) {
              pass('stl_file', '本次回复包含 stl 文件产物');
            } else {
              fail('stl_file', 'NO_STL_FILE', '本次回复中未检测到 stl 文件（.stl 链接/查看器）');
            }
          }

          // 材料计算（model + waterlily）专属验收：追问与补充处理 / Profile / 候选结论 / 结构化产物 / 内容匹配。
          // 不继承物理的 Step 1-6 / PNG 要求；Profile 与字段按真实 Run 定标。
          if (IS_MATERIAL_CASE) {
            if (serviceDown) {
              skip('material_dialog', '服务不可用，未进入执行');
            } else if (materialDialogSeen && materialDialogDismissed) {
              pass('material_dialog', '「追问与补充」对话框已按默认「停 止」关闭');
            } else if (materialDialogSeen) {
              fail('material_dialog', 'DIALOG_STUCK', '「追问与补充」对话框出现但无法关闭（停 止 按钮不可用）');
            } else {
              pass('material_dialog', '未出现「追问与补充」对话框，无需处理');
            }

            if (serviceDown) {
              skip('material_profile', '服务不可用，未进入执行');
            } else if (materialProfile === 'retrieval' && materialZhSearchSeen && materialRetrievalProgressSeen) {
              pass('material_profile', '检索综合型流程完整：中文检索项+检索进度+综合回答');
            } else if (materialProfile === 'retrieval') {
              fail('material_profile', 'NO_RETRIEVAL_PROGRESS', `出现「综合回答」但检索字段缺失：中文检索项=${materialZhSearchSeen}，检索进度=${materialRetrievalProgressSeen}`);
            } else if (materialProfile === 'analysis') {
              pass('material_profile', '文本分析型流程完整：材料分析章节+追问推荐');
            } else {
              fail('material_profile', 'NO_MATERIAL_PROFILE', '未检测到「综合回答」或「追问推荐」任一完成信号');
            }

            if (serviceDown) {
              skip('material_conclusion', '服务不可用，未进入执行');
            } else if (materialProfile === 'retrieval') {
              const comprehensiveSection = assistantText.includes('综合回答')
                ? assistantText.slice(assistantText.indexOf('综合回答'))
                : '';
              if (MATERIAL_CONCLUSION_RE.test(comprehensiveSection)) {
                pass('material_conclusion', '综合回答区段包含候选/性能/方案结论');
              } else {
                fail('material_conclusion', 'NO_MATERIAL_CONCLUSION', '综合回答区段缺少候选或性能结论表述');
              }
            } else if (materialZhuituiSeen) {
              pass('material_conclusion', '文本分析已给出追问推荐/本轮建议');
            } else {
              fail('material_conclusion', 'NO_MATERIAL_CONCLUSION', '未给出候选、结论或追问推荐');
            }

            if (serviceDown) {
              skip('material_product', '服务不可用，未进入执行');
            } else if (materialProducts.length > 0) {
              pass('material_product', `检测到结构化产物：${materialProducts.join('/')}`);
            } else {
              pass('material_product', '文本型输出，无结构化产物（按卡片实际能力验收）');
            }

            if (serviceDown) {
              skip('keyword', '服务不可用，未进入执行');
            } else {
              const keywordMatch = matchCaseKeywords(title, assistantText);
              if (keywordMatch.matched) {
                pass('keyword', `本次回复命中领域词：${keywordMatch.hits.join('/')}`);
              } else {
                fail('keyword', 'KEYWORD_MISMATCH', `本次回复领域词不足（命中 ${keywordMatch.hits.join('/') || '无'}；至少需 ${keywordMatch.requiredHits} 项）`);
              }
            }
          }

          // 物理求解必须出现任务完成标志；数据建模按专属流程（文案齐全 + stl）；
          // 材料计算按自身 Profile 完成（综合回答 或 追问推荐）；其他分类只要求新增回复已结束。
          if (serviceDown) {
            skip('complete', '服务不可用，未进入执行');
          } else if (IS_PHYSICS_CASE && newComplete) {
            pass('complete', '检测到物理任务「执行完成」');
          } else if (IS_DATA_CASE && dataComplete) {
            pass('complete', '数据建模流程完整：流程文案齐全且 stl 文件已生成');
          } else if (IS_MATERIAL_CASE && materialDone) {
            pass('complete', materialProfile === 'retrieval'
              ? '材料检索流程完整：综合回答已生成'
              : '材料分析流程完整：追问推荐已给出');
          } else if (!IS_PHYSICS_CASE && !IS_DATA_CASE && !IS_MATERIAL_CASE && genericComplete) {
            pass('complete', '新增 assistant 回复已完成');
          } else {
            fail('complete', newFailure ? 'EXECUTION_FAILED' : 'NOT_COMPLETE', newFailure ? '任务执行失败' : (IS_PHYSICS_CASE ? '未检测到物理任务执行完成' : IS_DATA_CASE ? '数据建模流程未走完（文案或 stl 产物缺失）' : IS_MATERIAL_CASE ? `材料流程未走完（已见 综合回答=${materialComprehensiveSeen}，中文检索项=${materialZhSearchSeen}，追问推荐=${materialZhuituiSeen}，稳定轮=${stableRounds}，空轮=${nullRounds}）` : '新增回复仍在生成或未完成'));
          }

          result.checks = itemChecks;
          result.firstOutputMs = firstOutputMs;
          result.stepsSeen = [...stepsSeen].sort().join(',');
          result.pngSeen = pngSeen;
          result.codeBlocks = { s5: codeBlocks.s5, s6: codeBlocks.s6 };
          result.dataPhrases = IS_DATA_CASE ? [...dataPhrasesSeen] : null;
          result.stlSeen = IS_DATA_CASE ? stlSeen : null;
          result.materialProfile = IS_MATERIAL_CASE ? materialProfile : null;
          result.materialFields = IS_MATERIAL_CASE ? {
            dialogSeen: materialDialogSeen,
            dialogDismissed: materialDialogDismissed,
            zhSearch: materialZhSearchSeen,
            retrievalProgress: materialRetrievalProgressSeen,
            comprehensive: materialComprehensiveSeen,
            zhuitui: materialZhuituiSeen,
            analysis: materialAnalysisSeen,
          } : null;
          result.materialProducts = IS_MATERIAL_CASE ? materialProducts : null;
          result.materialDebug = IS_MATERIAL_CASE ? {
            peakLen: materialPeakText.length,
            stableRounds,
            nullRounds,
          } : null;
          result.keywordHit = (IS_PHYSICS_CASE || IS_MATERIAL_CASE) && !serviceDown
            ? matchCaseKeywords(title, assistantText).matched
            : null;
          result.status = itemChecks.every((c) => c.status === 'passed') ? 'PASSED' : 'FAILED';
          if (result.status !== 'PASSED') {
            result.reason = itemChecks.filter((c) => c.status !== 'passed').map((c) => `${c.key}:${c.errorCode || c.status}`).join(',');
          }
          } // 关闭「Run 点击成功」else 块（waitForAssistantSettled 基线模式）
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
    console.log(`[case ${index + 1}/${titles.length}] ${title} - ${result.status} (${result.durationMs} ms)${result.reason ? ` reason=${result.reason}` : ''}`);
  }

  const report = {
    capturedAt: new Date().toISOString(),
    environment: page.url(),
    category: CATEGORY,
    categoryLabel: CATEGORY_LABEL,
    dryRun: DRY_RUN,
    selectedCategory: selected,
    panelExpanded,
    navigationError,
    cardCount,
    matchedCount: titles.length,
    results
  };
  const outputDir = path.join('results/runs/batch_cases', CATEGORY);
  await fs.mkdir(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `batch-case-results-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8');
  await testInfo.attach('batch-case-results.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });

  const checks = results.length
    ? results.flatMap((r, i) => {
        // 验收模式：展开每案例的独立检查项（service/first_output/steps/codeblocks/png/keyword/complete）
        if (r.checks && r.checks.length > 0) {
          const caseKey = checkKey(r.title || `case_${i + 1}`, `case_${i + 1}`);
          const catalogPrefix = CASE_CATALOG_INDEX > 0 ? `#${CASE_CATALOG_INDEX} ` : '';
          const caseTitle = `${catalogPrefix}${(r.title || `案例${i + 1}`).slice(0, 48)}`.trim();
          return r.checks.map((c) => {
            const itemLabel = {
              service: '服务可用',
              first_output: '首输出延迟',
              assistant_reply: '新建回复',
              steps: 'Step 1-6 流程',
              codeblocks: '代码块（Step5/6）',
              png: 'PNG 图',
              keyword: '内容匹配',
              complete: '执行完成',
              cad_flow: '建模流程文案',
              stl_file: 'STL 文件',
              material_dialog: '追问与补充',
              material_profile: '材料流程',
              material_conclusion: '候选/结论',
              material_product: '结构化产物',
            }[c.key] || c.key;
            const detail = String(c.message || '').slice(0, 200);
            const failed = c.status !== 'passed';
            return {
              // 只加一层 category，避免 physics_physics_ 双前缀
              key: checkKey(`${CATEGORY}_${caseKey}_${c.key}`, `${CATEGORY}_item`),
              status: c.status,
              durationMs: c.durationMs || 0,
              errorCode: c.errorCode || null,
              // message 留给兼容：短中文细节
              message: detail || null,
              // Admin 标题用「#序号 案例名 · 检查项」
              messageZh: `${caseTitle} · ${itemLabel}`.slice(0, 100),
              // 失败原因：直接用验收句，不带 Playwright 堆栈
              failureReason: failed ? detail : null,
              failureReasonZh: failed ? detail : null,
            };
          });
        }
        const blockedDetail = stripBlockedReason(r.reason || r.title || '案例未执行');
        const catalogPrefix = CASE_CATALOG_INDEX > 0 ? `#${CASE_CATALOG_INDEX} ` : '';
        const blockedTitle = `${catalogPrefix}${(r.title || '案例').slice(0, 40)}`.trim();
        return [{
          // 中文标题经 checkKey 归一化后会塌缩成同一 key（如 material），
          // 用案例序号生成唯一标识，标题保留在 messageZh 中展示。
          key: checkKey(`${CATEGORY}_case_${i + 1}`, `${CATEGORY}_item`),
          status: mapItemStatus(r.status),
          durationMs: r.durationMs || 0,
          errorCode: ['PASSED', 'DISCOVERED'].includes(r.status) ? null : (r.status || 'FAILED'),
          message: blockedDetail,
          messageZh: `${blockedTitle} · 启动`.slice(0, 80),
          failureReason: ['PASSED', 'DISCOVERED'].includes(r.status) ? null : blockedDetail,
          failureReasonZh: ['PASSED', 'DISCOVERED'].includes(r.status) ? null : blockedDetail,
        }];
      })
    : [{
        key: 'no_cases',
        status: 'error',
        durationMs: 0,
        errorCode: 'NO_CASES',
        message: '未找到可执行案例',
        messageZh: '案例加载',
        failureReason: '分类下没有可执行的案例卡片',
        failureReasonZh: '分类下没有可执行的案例卡片',
      }];
  // 不再二次加 category 前缀（上面已含 CATEGORY_）
  // Admin 单次最多接收 50 项检查。详细项始终写在本地结果中；超过上限时，
  // 上报一个汇总项，避免“测试已跑完但整份报告被后端拒绝”的假象。
  const reportChecks = checks.length <= 50
    ? checks
    : [{
        key: 'batch_summary',
        status: results.every((r) => r.status === 'PASSED') ? 'passed' : 'failed',
        durationMs: results.reduce((total, r) => total + (r.durationMs || 0), 0),
        errorCode: checks.length > 50 ? 'DETAILS_LOCAL_ONLY' : null,
        message: `${CATEGORY_LABEL} ${results.length} 个案例，${checks.length} 项详细验收已保存到本地报告`,
        messageZh: '批量汇总',
        failureReason: null,
        failureReasonZh: null,
      }];
  if (!DRY_RUN) {
    await finishSuiteReport({
      page, testInfo,
      suiteId: SUITE_ID,
      startedAt: suiteStartedAt,
      checks: reportChecks,
      errorSummary: results.filter((r) => !['PASSED', 'DISCOVERED'].includes(r.status)).map((r) => r.title || r.status).join(',').slice(0, 500) || null,
    });
  }

  // BLOCKED 也计入失败：案例没跑成（卡片未加载/未找到）不能算通过。
  const unsuccessful = results.filter(result => ['FAILED', 'TIMEOUT', 'BLOCKED'].includes(result.status));
  expect(unsuccessful, '至少一个案例未成功完成 Run').toHaveLength(0);
  // 阻塞必须让 CI 失败，避免“未登录/未找到案例”被误报为测试通过。
  expect(selected && titles.length > 0, '未成功加载分类案例；请确认登录状态和页面入口').toBeTruthy();
});

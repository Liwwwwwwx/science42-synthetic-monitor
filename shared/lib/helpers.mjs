import { expect } from '@playwright/test';
import { cfg, requireEnv } from '../config/test-config.mjs';

const SELECTED_CONVERSATION_KEY = 'ximu:selected-conversation-id';
const CHAT_CATEGORY_LABELS = ['数据建模', '数学建模', '物理求解', '材料计算', 'AdvancedResearch'];
export const CONVERSATION_MISMATCH_ERROR_CODE = 'CONVERSATION_MISMATCH';

async function waitForInputEnabled(page, input, timeoutMs) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (await input.isVisible().catch(() => false) && !(await input.isDisabled().catch(() => true))) {
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function actionIsSelected(action) {
  return /selected/i.test(await action.getAttribute('class').catch(() => '') || '');
}

async function clickAndConfirmCategory(page, action, timeoutMs) {
  if (await actionIsSelected(action)) return true;
  try {
    await action.click({ timeout: Math.max(1, Math.min(3_000, timeoutMs)) });
  } catch {
    return false;
  }
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (await actionIsSelected(action)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * 选择聊天页能力分类，并以选中样式确认点击真正生效。
 * 不能只把 click() 成功当作分类已切换：SPA 重渲染或重复文案可能吞掉点击。
 */
export async function selectChatCategory(page, categoryLabel, timeoutMs = 15_000) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    const actions = page.locator('div[class*="chat-action"]');
    for (let index = 0; index < await actions.count(); index += 1) {
      const action = actions.nth(index);
      if ((await action.innerText().catch(() => '')).trim() !== categoryLabel) continue;
      if (!(await action.isVisible().catch(() => false))) continue;
      if (await clickAndConfirmCategory(page, action, Math.min(5_000, deadline - Date.now()))) return true;
    }

    // 线上编译产物的 action class 偶尔变化；只接受能回溯到 chat-action 的精确文案，
    // 避免误点案例正文、弹窗或历史消息中的同名文本。
    const labels = page.getByText(categoryLabel, { exact: true });
    for (let index = await labels.count() - 1; index >= 0; index -= 1) {
      const label = labels.nth(index);
      if (!(await label.isVisible().catch(() => false))) continue;
      const action = label.locator('xpath=ancestor-or-self::div[contains(@class,"chat-action")][1]');
      if (await action.count().catch(() => 0) !== 1) continue;
      if (await clickAndConfirmCategory(page, action, Math.min(5_000, deadline - Date.now()))) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

export async function getCurrentConversationId(page) {
  return page.evaluate((storageKey) => sessionStorage.getItem(storageKey), SELECTED_CONVERSATION_KEY);
}

export async function waitForCurrentConversation(page, expectedConversationId, timeoutMs = 5_000) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (await getCurrentConversationId(page) === expectedConversationId) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

export async function assertCurrentConversation(page, expectedConversationId, timeoutMs = 5_000) {
  if (!(await waitForCurrentConversation(page, expectedConversationId, timeoutMs))) {
    const error = new Error('当前页面会话与自动化专用会话不一致');
    error.code = CONVERSATION_MISMATCH_ERROR_CODE;
    throw error;
  }
}

export async function loginIfNeeded(page) {
  await page.goto(cfg.entryPath);
  const password = page.locator(cfg.selectors.password);
  if (await password.count() > 0) {
    requireEnv('SCIENCE42_USER', cfg.user);
    requireEnv('SCIENCE42_PASSWORD', cfg.password);
    await page.locator(cfg.selectors.username).fill(cfg.user);
    await password.fill(cfg.password);
    const agreement = page.locator('input[type="checkbox"]');
    if (await agreement.count() === 1) await agreement.check();
    if (await page.getByText('拖拽滑块完成验证', { exact: false }).count() > 0) {
      throw new Error('Manual login required: complete the slider captcha once, then save SCIENCE42_STORAGE_STATE.');
    }
    await page.locator(cfg.selectors.login).click();
  }
  // Dismiss any blocking modals (e.g. pricing/upgrade dialog)
  await page.locator('.ant-modal-wrap').first().waitFor({ state: 'visible', timeout: 5_000 }).then(
    async () => {
      await page.locator('.ant-modal-close, .ant-modal-wrap button:has-text("取 消")').first().click();
      await page.waitForTimeout(500);
    }
  ).catch(() => {});
  const returnChat = page.getByRole('button', { name: /返回聊天/ });
  if (await returnChat.count() === 1) await returnChat.click();
  else if (await page.locator(cfg.selectors.input).count() === 0) await page.goto(cfg.chatPath);
  await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 20_000 });
  await assertConversationAuthenticated(page);
}

/**
 * 输入框对访客也可能可见，因此不能以页面可见性判断登录成功。
 * 会话接口由 Next 代理读取目标站 Cookie；401 说明 storage state 与当前目标站不匹配或已过期。
 */
export async function assertConversationAuthenticated(page) {
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/conversation/conversations?page=1&limit=1', { credentials: 'include' });
    return response.status;
  });
  if (status !== 200) {
    throw new Error(`登录态无效（conversation API HTTP ${status}）；请在当前 SCIENCE42_BASE_URL 下执行 npm run auth:setup 后重试`);
  }
}

export async function newConversation(page, categoryLabel) {
  await page.goto(cfg.chatPath);
  const newChat = page.getByRole('button', { name: '新建聊天', exact: true });
  // 必须等待「新建聊天」按钮渲染后再点击：并发批量任务时服务器同时跑多个
  // chromium、页面渲染慢，goto 后立即检查 isVisible 会拿到 false → 跳过点击 →
  // 消息发到当前旧会话 → 无新会话创建 → ensureMonitoringConversation 轮询
  // 找不到新 conversation id → 整卡 BLOCKED（2026-08-05 服务器并发实测）。
  let clickIssued = false;
  let ready = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !ready) {
    if (!clickIssued && await newChat.isVisible().catch(() => false)) {
      try {
        await newChat.click();
        clickIssued = true;
      } catch {
        await page.waitForTimeout(500);
        continue;
      }
    }
    if (clickIssued) {
      await page.waitForTimeout(800);
      const input = page.locator(cfg.selectors.input).last();
      // 点击生效的标志：输入框存在且可见（新会话视图渲染完成）。
      ready = (await input.count()) > 0 && (await input.isVisible().catch(() => false));
    } else {
      await page.waitForTimeout(500);
    }
  }
  // 未点中（页面异常/按钮不存在）不抛错：走下方分类标签激活的降级路径，
  // 由 ensureMonitoringConversation 的轮询兜底判定（找不到新 id 会 BLOCKED）。
  // Science42 新版首页 input 默认 disabled，必须用本套件目标分类激活。
  // 未指定分类的通用套件保留原先的“第一个可用分类”降级行为。
  await activateChatInput(page, categoryLabel);
}

export async function activateChatInput(page, categoryLabel, timeoutMs = 15_000) {
  const input = page.locator(cfg.selectors.input).last();
  if (!(await input.isVisible().catch(() => false))) return;
  // 显式分类必须无条件切换，不能因为输入框已启用就沿用上一个模块。
  if (categoryLabel) {
    if (!(await selectChatCategory(page, categoryLabel, timeoutMs))) {
      throw new Error(`无法选择“${categoryLabel}”聊天分类`);
    }
    if (await waitForInputEnabled(page, input, timeoutMs)) return categoryLabel;
    throw new Error(`无法用“${categoryLabel}”激活聊天输入框`);
  }
  if (!(await input.isDisabled().catch(() => false))) return;
  const labels = CHAT_CATEGORY_LABELS;
  const deadline = Date.now() + Math.max(1, timeoutMs);
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // 通用降级要给后续分类留下尝试机会。
    const selectionBudget = Math.max(
      1,
      Math.min(3_000, Math.floor(remaining / (labels.length - index))),
    );
    if (!(await selectChatCategory(page, label, selectionBudget))) continue;
    if (await waitForInputEnabled(page, input, deadline - Date.now())) return label;
  }
  throw new Error('无法用任一聊天分类激活输入框');
}

/**
 * 每个监控用途只保留一条专用会话：首次创建并以 title 作为首段内容，
 * 后续从最近对话中切回复用，避免持续消耗产品的会话数量上限。
 */
export async function ensureMonitoringConversation(page, title, { categoryLabel } = {}) {
  const conversations = async () => page.evaluate(async () => {
    const response = await fetch('/api/conversation/conversations?page=1&limit=100', {
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`conversation list HTTP ${response.status}`);
    const body = await response.json();
    const items = Array.isArray(body) ? body : body?.data?.conversations || body?.conversations || body?.data?.items || body?.items || [];
    return Array.isArray(items) ? items.map((item) => ({ id: String(item.id || ''), title: String(item.title || '') })) : [];
  });
  // 创建+改名存在并发竞态：并发进程几乎同时点「新建聊天」时可能拿到同一会话，
  // 各自 rename 成自己的槽位标题（beforeIds 不含对方刚建的会话）。
  // 因此改名后二次确认标题存在；被并发进程改名则重试一次完整流程。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = (await conversations()).find((item) => item.title === title);
    if (existing) {
      return {
        created: false,
        selected: await selectMonitoringConversation(page, {
          conversationId: existing.id,
          title,
          categoryLabel,
        }),
        conversationId: existing.id,
      };
    }
    const beforeIds = new Set((await conversations()).map((item) => item.id));
    await newConversation(page, categoryLabel);
    await sendAndMeasure(page, `${title}。这是自动化测试专用会话，请保留该会话用于后续测试。`);
    let createdId = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !createdId) {
      const latest = await conversations();
      createdId = latest.find((item) => item.id && !beforeIds.has(item.id))?.id || '';
      if (!createdId) await page.waitForTimeout(500);
    }
    if (!createdId) throw new Error('新建监控会话后未找到服务端 conversation id');
    await assertCurrentConversation(page, createdId, 5_000);
    await page.evaluate(async ({ conversationId, conversationTitle }) => {
      const response = await fetch('/api/conversation/update_title', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ external_id: conversationId, title: conversationTitle }),
      });
      if (!response.ok) throw new Error(`conversation title HTTP ${response.status}`);
    }, { conversationId: createdId, conversationTitle: title });
    if ((await conversations()).some((item) => item.title === title)) {
      return { created: true, selected: true, conversationId: createdId };
    }
    // 标题未确认（可能被并发进程改名）：重试一次完整创建流程。
  }
  throw new Error(`监控会话「${title}」创建后标题确认失败（可能被并发进程改名）`);
}

/**
 * 从懒加载会话列表选择指定服务端会话。
 * 标题只用于定位候选项，最终必须以 sessionStorage 中的 conversation ID 确认。
 */
export async function selectMonitoringConversation(page, {
  conversationId,
  title,
  categoryLabel,
  maxRounds = 10,
}) {
  const listSelector = '[class*="recent-list"], [class*="chat-list"]';
  for (let round = 0; round < maxRounds; round += 1) {
    const items = page.locator('[class*="chat-item"]');
    for (let index = 0; index < await items.count(); index += 1) {
      const item = items.nth(index);
      const itemTitleNode = item.locator('[class*="chat-item-title"]').first();
      const itemTitle = (await itemTitleNode.innerText().catch(() => '')).trim()
        || ((await item.getAttribute('title').catch(() => '')) || '').split('\n')[0].trim()
        || (await item.innerText().catch(() => '')).split('\n')[0].trim();
      if (itemTitle !== title) continue;

      await item.click();
      await page.locator(cfg.selectors.input).last().waitFor({ state: 'visible', timeout: 15_000 });
      // 同名会话可能不止一条；只有刷新锚点与服务端 ID 一致才算选中。
      if (!(await waitForCurrentConversation(page, conversationId, 3_000))) continue;
      await activateChatInput(page, categoryLabel);
      return true;
    }

    // 虚拟列表滚动后元素数量可能保持不变，因此不能用 count 未增长提前退出。
    await page.evaluate((selector) => {
      const lists = document.querySelectorAll(selector);
      for (const list of lists) list.scrollTop = list.scrollHeight;
    }, listSelector);
    await page.waitForTimeout(1_500);
  }
  return false;
}

/**
 * 发送后新增消息的噪音文本（渲染装饰/占位），剥离后若为空说明仍在生成。
 * - 「秋月白为您服务~」：产品端欢迎语占位（先出，正文后写）
 * - 重试/删除/复制/收藏：消息操作按钮（虚拟列表重渲染时可能混入 innerText）
 * - 时间戳（`8/5/2026, 10:19:19 AM` 与 ISO 两种形态）：消息元信息
 * - 生成中/Generating：流式生成状态
 */
const NOISE_RE = /秋月白为您服务~|重试|删除|复制|收藏|生成中|Generating|\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gi;

/** 剥离渲染噪音后是否仍有实质回答内容。 */
function hasMeaningfulContent(text) {
  return text.replace(NOISE_RE, '').trim().length > 0;
}

/**
 * 当前所有 assistant 消息的 id 集合（只按 id 识别新旧，不比较文本：
 * 虚拟列表重渲染会让历史消息 innerText 抖动，id+text 组合去重会把
 * 抖动后的历史消息误判为"新消息"，导致稳定轮次被反复重置而超时）。
 */
async function assistantMessageIds(page) {
  const messages = page.locator('[data-role="assistant"]');
  const ids = new Set();
  for (let index = 0; index < await messages.count(); index += 1) {
    const message = messages.nth(index);
    const content = message.locator('[data-message-id]').last();
    const id = await content.getAttribute('data-message-id').catch(() => null);
    if (id) ids.add(id);
  }
  return ids;
}

export async function sendAndMeasure(page, question) {
  const input = page.locator(cfg.selectors.input).last();
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled({ timeout: 15_000 });
  const beforeIds = await assistantMessageIds(page);
  const started = Date.now();
  await input.fill(question);
  await input.press('Enter');
  let firstMs = null;
  let finalText = '';
  // 每条发送后新增的消息独立追踪稳定轮次：id → { text, stableRounds }
  const candidates = new Map();
  const deadline = Date.now() + cfg.maxTaskMs;
  while (Date.now() < deadline) {
    const messages = page.locator('[data-role="assistant"]');
    for (let index = await messages.count() - 1; index >= 0; index -= 1) {
      const message = messages.nth(index);
      const content = message.locator('[data-message-id]').last();
      const id = await content.getAttribute('data-message-id').catch(() => null);
      // 只接受发送后新增的消息 id；历史消息（含文本抖动）一律忽略。
      if (!id || beforeIds.has(id)) continue;
      const text = ((await content.innerText().catch(() => '')) || await message.innerText().catch(() => '')).trim();
      if (!text) continue; // 空内容：占位/仍在生成，跳过
      if (firstMs === null) firstMs = Date.now() - started;
      finalText = text;
      const entry = candidates.get(id);
      if (entry && entry.text === text) {
        entry.stableRounds += 1;
      } else {
        candidates.set(id, { text, stableRounds: 1 });
      }
      // 完成判定：同一消息文本连续 3 轮稳定（1.5s）、不在生成中、且剥离渲染噪音后仍有实质内容。
      // 仅欢迎语/按钮/时间戳不算完成，避免把占位消息误判为回答（假通过）。
      if (candidates.get(id).stableRounds >= 3
        && !/生成中|Generating/i.test(text)
        && hasMeaningfulContent(text)) {
        const failed = /失败|错误|超时|failed/i.test(text);
        return {
          question,
          responseFingerprint: text.slice(-240),
          firstMs,
          finalMs: Date.now() - started,
          status: failed ? 'failed' : 'completed',
          observedAt: new Date().toISOString(),
        };
      }
    }
    await page.waitForTimeout(500);
  }
  const failed = /失败|错误|超时|failed/i.test(finalText);
  return { question, responseFingerprint: finalText.slice(-240), firstMs, finalMs: Date.now() - started, status: failed ? 'failed' : 'timeout', observedAt: new Date().toISOString() };
}

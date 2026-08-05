import { expect } from '@playwright/test';
import { cfg, requireEnv } from '../config/test-config.mjs';

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

export async function newConversation(page) {
  await page.goto(cfg.chatPath);
  const newChat = page.getByRole('button', { name: '新建聊天', exact: true });
  if (await newChat.isVisible().catch(() => false)) {
    await newChat.click();
    await page.waitForTimeout(500);
  }
  // Science42 新版首页 input 默认 disabled，点分类标签激活对话
  const input = page.locator(cfg.selectors.input).last();
  if (await input.isVisible().catch(() => false) && await input.isDisabled().catch(() => false)) {
    for (const label of ['数据建模', '数学建模', '物理求解', '材料计算', 'AdvancedResearch']) {
      const tag = page.locator('main').getByText(label, { exact: true }).first();
      if (await tag.count() === 1 && await tag.isVisible().catch(() => false)) {
        await tag.click().catch(() => {});
        await page.waitForTimeout(1000);
        break;
      }
    }
  }
}

export async function activateChatInput(page) {
  const input = page.locator(cfg.selectors.input).last();
  if (!(await input.isVisible().catch(() => false)) || !(await input.isDisabled().catch(() => false))) return;
  for (const label of ['数据建模', '数学建模', '物理求解', '材料计算', 'AdvancedResearch']) {
    const tag = page.locator('main').getByText(label, { exact: true }).first();
    if (await tag.count() === 1 && await tag.isVisible().catch(() => false)) {
      await tag.click();
      await expect(input).toBeEnabled({ timeout: 15_000 });
      return;
    }
  }
}

/**
 * 每个监控用途只保留一条专用会话：首次创建并以 title 作为首段内容，
 * 后续从最近对话中切回复用，避免持续消耗产品的会话数量上限。
 */
export async function ensureMonitoringConversation(page, title) {
  const conversations = async () => page.evaluate(async () => {
    const response = await fetch('/api/conversation/conversations?page=1&limit=100', {
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`conversation list HTTP ${response.status}`);
    const body = await response.json();
    const items = Array.isArray(body) ? body : body?.data?.conversations || body?.conversations || body?.data?.items || body?.items || [];
    return Array.isArray(items) ? items.map((item) => ({ id: String(item.id || ''), title: String(item.title || '') })) : [];
  });
  const select = async () => {
    // 精确匹配标题：hasText 是子串匹配，「物理案例-1」会命中「物理案例-10/12」等。
    const items = page.locator('[class*="chat-item"]');
    for (let index = 0; index < await items.count(); index += 1) {
      const item = items.nth(index);
      const itemTitle = (await item.getAttribute('title').catch(() => '')) || (await item.innerText().catch(() => '')).trim();
      if (itemTitle === title) {
        await item.click();
        await expect(page.locator(cfg.selectors.input).last()).toBeVisible({ timeout: 15_000 });
        await activateChatInput(page);
        return true;
      }
    }
    // 当前本地 XIMU 的 /#/chat 会重定向到首页工作台；该视图没有历史会话列表。
    // 此时不能把「列表不可见」当成案例执行失败，继续使用已恢复的浏览器会话状态即可。
    return false;
  };

  // 创建+改名存在并发竞态：并发进程几乎同时点「新建聊天」时可能拿到同一会话，
  // 各自 rename 成自己的槽位标题（beforeIds 不含对方刚建的会话）。
  // 因此改名后二次确认标题存在；被并发进程改名则重试一次完整流程。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await conversations()).some((item) => item.title === title)) {
      return { created: false, selected: await select() };
    }
    const beforeIds = new Set((await conversations()).map((item) => item.id));
    await newConversation(page);
    await activateChatInput(page);
    await sendAndMeasure(page, `${title}。这是自动化测试专用会话，请保留该会话用于后续测试。`);
    let createdId = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !createdId) {
      const latest = await conversations();
      createdId = latest.find((item) => item.id && !beforeIds.has(item.id))?.id || '';
      if (!createdId) await page.waitForTimeout(500);
    }
    if (!createdId) throw new Error('新建监控会话后未找到服务端 conversation id');
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
      return { created: true, selected: await select() };
    }
    // 标题未确认（可能被并发进程改名）：重试一次完整创建流程。
  }
  throw new Error(`监控会话「${title}」创建后标题确认失败（可能被并发进程改名）`);
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

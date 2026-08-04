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
    const existing = page.locator('[class*="chat-item"]').filter({ hasText: title }).first();
    // 当前本地 XIMU 的 /#/chat 会重定向到首页工作台；该视图没有历史会话列表。
    // 此时不能把“列表不可见”当成案例执行失败，继续使用已恢复的浏览器会话状态即可。
    if (!(await existing.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
    await existing.click();
    await expect(page.locator(cfg.selectors.input).last()).toBeVisible({ timeout: 15_000 });
    await activateChatInput(page);
    return true;
  };

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
  return { created: true, selected: await select() };
}

async function assistantSnapshot(page) {
  const messages = page.locator('[data-role="assistant"]');
  const snapshot = new Set();
  for (let index = 0; index < await messages.count(); index += 1) {
    const message = messages.nth(index);
    const content = message.locator('[data-message-id]').last();
    const id = await content.getAttribute('data-message-id').catch(() => null);
    const text = ((await content.innerText().catch(() => '')) || await message.innerText().catch(() => '')).trim();
    snapshot.add(`${id || index}\u0000${text}`);
  }
  return snapshot;
}

export async function sendAndMeasure(page, question) {
  const input = page.locator(cfg.selectors.input).last();
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled({ timeout: 15_000 });
  const before = await assistantSnapshot(page);
  const started = Date.now();
  await input.fill(question);
  await input.press('Enter');
  let firstMs = null;
  let finalText = '';
  let previousSignature = '';
  let stableRounds = 0;
  const deadline = Date.now() + cfg.maxTaskMs;
  while (Date.now() < deadline) {
    const messages = page.locator('[data-role="assistant"]');
    for (let index = await messages.count() - 1; index >= 0; index -= 1) {
      const message = messages.nth(index);
      const content = message.locator('[data-message-id]').last();
      const id = await content.getAttribute('data-message-id').catch(() => null);
      const text = ((await content.innerText().catch(() => '')) || await message.innerText().catch(() => '')).trim();
      if (!text || before.has(`${id || index}\u0000${text}`)) continue;
      if (firstMs === null) firstMs = Date.now() - started;
      finalText = text;
      const signature = `${id || index}\u0000${text}`;
      stableRounds = signature === previousSignature ? stableRounds + 1 : 0;
      previousSignature = signature;
      // 只接受发送后新增/更新的 assistant 消息；连续两轮稳定且不在生成中才视为本次回答完成。
      if (!/生成中|Generating/i.test(text) && stableRounds >= 2) {
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

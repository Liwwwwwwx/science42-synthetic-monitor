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
}

export async function newConversation(page) {
  await page.goto(cfg.chatPath);
  await page.waitForTimeout(1000);
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

export async function sendAndMeasure(page, question) {
  const input = page.locator(cfg.selectors.input).last();
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled({ timeout: 15_000 });
  const started = Date.now();
  await input.fill(question);
  const responsePromise = page.waitForResponse(r => r.url().includes('/api/') && r.request().method() !== 'OPTIONS').catch(() => null);
  await input.press('Enter');
  const firstText = page.locator('main p, main pre, main code').filter({ hasText: /./ }).last();
  await firstText.waitFor({ state: 'visible', timeout: cfg.maxTaskMs });
  const firstMs = Date.now() - started;
  await page.waitForTimeout(500);
  const finalMs = Date.now() - started;
  const body = await page.locator('main').innerText();
  const tail = body.slice(-1200);
  const status = /生成中|Generating/.test(tail) ? 'streaming' : (/失败|错误|超时|failed/i.test(tail) ? 'failed' : 'completed');
  const response = await responsePromise;
  return { question, firstMs, finalMs, status, httpStatus: response?.status() ?? null, observedAt: new Date().toISOString() };
}

import { test, expect } from '@playwright/test';
import { loginIfNeeded, newConversation, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'session_recovery';

test('SR-30 smoke: conversation persisted and discoverable', async ({ page }) => {
  const startedAt = new Date();
  await loginIfNeeded(page);
  await newConversation(page);
  const sendStarted = Date.now();
  const result = await sendAndMeasure(page, '会话恢复测试：只回答"通过"。');
  expect(result.status).toBe('completed');
  // Verify conversation appears in sidebar history
  const sidebar = page.locator('complementary, [class*="SideBar"], [class*="sidebar"]').first();
  await expect(sidebar.getByText('会话恢复测试').first()).toBeVisible({ timeout: 15_000 });
  const persisted = true;

  await finishSuiteReport({
    suiteId: SUITE_ID,
    startedAt,
    checks: [
      {
        key: 'send_message',
        status: mapItemStatus(result.status),
        durationMs: result.finalMs || Date.now() - sendStarted,
        errorCode: result.status === 'completed' ? null : 'SEND_FAILED',
        message: '发送会话恢复测试消息',
      },
      {
        key: 'conversation_persisted',
        status: persisted ? 'passed' : 'failed',
        durationMs: 0,
        errorCode: persisted ? null : 'NOT_PERSISTED',
        message: '对话出现在侧边栏历史列表',
      },
    ],
  });

  expect(persisted).toBeTruthy();
});

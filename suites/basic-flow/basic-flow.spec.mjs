import { test, expect } from '@playwright/test';
import questions from '../../shared/config/questions.json' with { type: 'json' };
import { cfg } from '../../shared/config/test-config.mjs';
import { ensureMonitoringConversation, loginIfNeeded, sendAndMeasure } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport, mapItemStatus } from '../../shared/report/index.mjs';

const SUITE_ID = 'basic_flow';

// 快检模式：供服务器定时任务高频巡检使用（每 10 分钟），只跑登录态与一次真实问答；
// 默认全量模式：登录态 + 10 题冒烟 + 30 轮长对话 + 刷新恢复（42 项），从 Admin 页面手动触发。
const QUICK_MODE = process.env.BASIC_FLOW_MODE === 'quick';
const pad = (n) => String(n).padStart(2, '0');

/** 期望的检查项 key 列表（按顺序）。 */
function expectedCheckKeys() {
  const keys = ['auth_state'];
  const smokeCount = QUICK_MODE ? 1 : questions.length;
  for (let i = 0; i < smokeCount; i++) keys.push(`q${pad(i + 1)}`);
  if (!QUICK_MODE) for (let i = 0; i < 30; i++) keys.push(`turn_${pad(i + 1)}`);
  if (!QUICK_MODE) keys.push('session_restore');
  return keys;
}

/** 某检查项失败/前置失败时的统一占位。 */
function prerequisiteCheck(key, message = 'auth_state failed') {
  return { key, status: 'error', durationMs: 0, errorCode: 'PREREQUISITE_FAILED', message };
}

test('基础功能：登录态 + 冒烟 + 长对话 + 刷新恢复', async ({ page }, testInfo) => {
  const startedAt = new Date();
  // 全量 40 次提问耗时较长；快检模式大幅缩短
  test.setTimeout(QUICK_MODE ? 150_000 : 900_000);

  const checks = [];
  const totalChecks = expectedCheckKeys().length;
  const record = (check) => {
    checks.push(check);
    // 后端任务会持续转发 stdout；前端据此逐项展示 42 项全量回归的进度。
    console.log(`[progress] basic ${checks.length}/${totalChecks} ${check.key} ${check.status}`);
  };
  const authAt = Date.now();
  let authenticated = false;

  // ── 1. 登录态 ──────────────────────────────────────────────
  try {
    await loginIfNeeded(page);
    authenticated = true;
    record({
      key: 'auth_state',
      status: 'passed',
      durationMs: Date.now() - authAt,
      message: '登录态可用，聊天输入框可见',
    });
  } catch (error) {
    record({
      key: 'auth_state',
      status: 'failed',
      durationMs: Date.now() - authAt,
      errorCode: 'AUTH_FAILED',
      message: String(error?.message || error).slice(0, 500),
    });
  }

  if (authenticated) {
    try {
      await ensureMonitoringConversation(page, '【自动化测试】基础功能');
    } catch (error) {
      const message = `基础功能专用会话未就绪：${String(error?.message || error).slice(0, 400)}`;
      for (const key of expectedCheckKeys().slice(1)) record(prerequisiteCheck(key, message));
    }

    if (checks.length === 1) {

      // ── 2. 冒烟：10 道固定题（同一会话） ─────────────────────
      const smokeCount = QUICK_MODE ? 1 : questions.length;
      let lastResult = null;
      for (let i = 0; i < smokeCount; i++) {
        const r = await sendAndMeasure(page, questions[i]);
        lastResult = r;
        record({
          key: `q${pad(i + 1)}`,
          status: mapItemStatus(r.status),
          durationMs: r.finalMs,
          errorCode: r.status === 'completed' ? null : 'CHECK_FAILED',
          message: r.question.slice(0, 500),
        });
      }

      // ── 3. 长对话：同一会话续接 30 轮（题目循环） ────────────
      if (!QUICK_MODE) {
        for (let i = 0; i < 30; i++) {
          const q = questions[i % questions.length];
          const r = await sendAndMeasure(page, q);
          lastResult = r;
          record({
            key: `turn_${pad(i + 1)}`,
            status: mapItemStatus(r.status),
            durationMs: r.finalMs,
            errorCode: r.status === 'completed' ? null : 'CHECK_FAILED',
            message: r.question.slice(0, 500),
          });
        }
      }

      // ── 4. 刷新恢复：仅全量回归校验 ──────────────────────────
      // 本地 XIMU 刷新后会回到工作台视图，快检只验证“能提问并得到本次新回答”。
      if (!QUICK_MODE) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(2_000);
        const after = await page.locator('main').innerText().catch(() => '');
        const restored = Boolean(lastResult && after.includes(lastResult.question) && lastResult.responseFingerprint && after.includes(lastResult.responseFingerprint));
        record({
          key: 'session_restore',
          status: restored ? 'passed' : 'failed',
          durationMs: 2_000,
          errorCode: restored ? null : 'RESTORE_FAILED',
          message: '刷新后会话内容保留',
        });
      }
    }
  } else {
    // 登录失败：后续检查项统一标记为前置失败，保证上报结构完整
    for (const key of expectedCheckKeys().slice(1)) {
      record(prerequisiteCheck(key));
    }
  }

  await finishSuiteReport({
    page, testInfo,
    suiteId: SUITE_ID,
    startedAt,
    checks,
  });

  const failed = checks.filter((c) => c.status !== 'passed');
  expect(failed, `基础功能失败项: ${JSON.stringify(failed.map((c) => c.key))}`).toHaveLength(0);
});

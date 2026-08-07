#!/usr/bin/env node
/**
 * P1：对 Science42 AdvancedResearch 问一题，输出结构化结果到 stdout 最后一行：
 *   __RESEARCH_RESULT__{json}
 *
 * 复用 shared/lib/helpers 的登录 / 新建会话 / 激活输入逻辑，避免硬等「新建聊天」按钮。
 *
 * 用法：
 *   node --env-file=.env scripts/ask-advanced-research.mjs --question-id=01-1
 *   node --env-file=.env scripts/ask-advanced-research.mjs --job=/tmp/job.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { getResearchQuestion } from '../shared/config/research-questions.mjs';
import { getStorageStatePath, getTargetUrl } from '../shared/config/project.mjs';
import { cfg } from '../shared/config/test-config.mjs';
import {
  activateChatInput,
  assertConversationAuthenticated,
  loginIfNeeded,
  newConversation,
} from '../shared/lib/helpers.mjs';

const FIRST_ANSWER_TIMEOUT = Number(process.env.FIRST_ANSWER_TIMEOUT_MS || 3 * 60 * 1000);
const ANSWER_TIMEOUT = Number(process.env.ANSWER_TIMEOUT_MS || 15 * 60 * 1000);
const STABLE_MS = Number(process.env.ANSWER_STABLE_MS || 12_000);
const POLL_MS = Number(process.env.ANSWER_POLL_MS || 1500);
const MIN_SAVED_ANSWER_CHARS = Number(process.env.MIN_SAVED_ANSWER_CHARS || 200);
// 研究计划长时间无实质进展则失败，避免 silent hang 到总超时
const RESEARCH_PLAN_STALL_TIMEOUT = Number(process.env.RESEARCH_PLAN_STALL_TIMEOUT_MS || 4 * 60 * 1000);
const RESEARCH_IN_PROGRESS = /(?:\[\s*Round\s*\d+\s*\]|正调取专业文献库|即刻启动深度检索|中文检索项|英文检索项|正在生成|生成中)/i;

function logProgress(msg) {
  // 写 stderr 也写 stdout，避免 npm pipe 缓冲导致前端日志空白
  const line = `[progress] ${msg}`;
  console.log(line);
  try { process.stderr.write(`${line}\n`); } catch { /* ignore */ }
}

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = async (locator) => (await locator.innerText().catch(() => '')).trim();

function emitResult(payload) {
  console.log(`__RESEARCH_RESULT__${JSON.stringify(payload)}`);
}

async function dismissBlockingUi(page) {
  // 定价/通用 ant 弹窗
  await page.locator('.ant-modal-wrap').first().waitFor({ state: 'visible', timeout: 2_000 }).then(
    async () => {
      await page.locator('.ant-modal-close, .ant-modal-wrap button:has-text("取 消"), .ant-modal-wrap button:has-text("取消"), .ant-modal-wrap button:has-text("稍后再说")').first().click().catch(() => {});
      await page.waitForTimeout(400);
    },
  ).catch(() => {});
  // 系统更新提示（会挡住发送）
  const later = page.getByRole('button', { name: /稍后再说/ });
  if (await later.isVisible().catch(() => false)) {
    await later.click().catch(() => {});
    await page.waitForTimeout(300);
    logProgress('dismissed system-update dialog');
  }
  const closeUpdate = page.locator('button:has-text("稍后再说"), [class*="update"] button:has-text("稍后再说")').first();
  if (await closeUpdate.isVisible().catch(() => false)) {
    await closeUpdate.click().catch(() => {});
  }
}

/**
 * 选中 AdvancedResearch 模式。
 * 兼容：chat-action 卡片 / 首页分类标签 / 已选中状态。
 */
async function chooseAdvancedResearch(page) {
  await dismissBlockingUi(page);

  const loginOverlay = page.locator(
    'div[class*="register-section"], div[class*="login-section"], [role="dialog"] input[type="password"]',
  );
  for (let i = 0; i < await loginOverlay.count(); i += 1) {
    if (await loginOverlay.nth(i).isVisible().catch(() => false)) {
      throw new Error('登录态失效或出现登录遮罩，请在 science42-synthetic-monitor 执行 npm run auth:setup');
    }
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // 1) chat-action 行
    const actions = page.locator('div[class*="chat-action"]');
    const actionCount = await actions.count();
    for (let i = 0; i < actionCount; i += 1) {
      const action = actions.nth(i);
      const text = await textOf(action);
      if (text !== 'AdvancedResearch' || !(await action.isVisible().catch(() => false))) continue;
      const cls = (await action.getAttribute('class')) || '';
      if (!cls.includes('selected')) {
        await action.click();
        await page.waitForTimeout(400);
      }
      const after = (await action.getAttribute('class')) || '';
      if (after.includes('selected')) {
        console.log('[progress] AdvancedResearch selected via chat-action');
        return;
      }
    }

    // 2) 主区标签文案
    const tag = page.locator('main').getByText('AdvancedResearch', { exact: true }).first();
    if ((await tag.count()) > 0 && (await tag.isVisible().catch(() => false))) {
      await tag.click().catch(() => {});
      await page.waitForTimeout(800);
      console.log('[progress] clicked AdvancedResearch tag');
      // 点标签后输入框应可输入，不一定有 selected class
      const input = page.locator(cfg.selectors.input).last();
      if ((await input.isVisible().catch(() => false)) && !(await input.isDisabled().catch(() => false))) {
        return;
      }
    }

    // 3) 任意可见「AdvancedResearch」文本节点
    const any = page.getByText('AdvancedResearch', { exact: true }).first();
    if ((await any.count()) > 0 && (await any.isVisible().catch(() => false))) {
      await any.click().catch(() => {});
      await page.waitForTimeout(800);
    }

    await activateChatInput(page);
    await page.waitForTimeout(500);
  }
  throw new Error('60 秒内未能选中 AdvancedResearch 模式；请确认登录态有效且页面可访问');
}

async function clickNewChatButton(page) {
  // 新版 UI：底部 36px 图标按钮，title/aria 为「新建聊天」，不一定有可见文案
  const candidates = [
    page.getByRole('button', { name: /新建聊天|新对话|新会话/ }),
    page.locator('button[title*="新建"], button[aria-label*="新建"]'),
    page.locator('[class*="icon-button"][title*="新建"], [class*="icon-button"][aria-label*="新建"]'),
    page.locator('button:has-text("新建聊天")'),
  ];
  for (const loc of candidates) {
    const btn = loc.first();
    if (!(await btn.count().catch(() => 0))) continue;
    if (!(await btn.isVisible().catch(() => false))) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
    }
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      return true;
    }
  }
  // 兜底：在 DOM 中找 title/aria 含「新建」的按钮（不依赖 Playwright role 可见性）
  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"], a')];
    const hit = buttons.find((el) => {
      const t = `${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      return /新建聊天|新对话|新会话/.test(t);
    });
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center', inline: 'center' });
    hit.click();
    return true;
  }).catch(() => false);
  return clicked;
}

/**
 * 强制进入空白新会话。旧版「新建聊天」文案按钮已改为底部图标；
 * 若不新建，消息会落入【自动化测试】基础功能 等超长会话，导致假发送/超时。
 */
async function forceNewChat(page) {
  await page.goto(cfg.chatPath, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissBlockingUi(page);
  await sleep(800);

  const usersBefore = await countUserMessages(page);
  let clicked = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !clicked) {
    clicked = await clickNewChatButton(page);
    if (!clicked) await sleep(500);
  }

  if (!clicked) {
    // 首页分类卡路径：/#/index 上点 AdvancedResearch 通常会开新草稿
    logProgress('新建聊天按钮未找到，尝试 /#/index 分类入口');
    await page.goto('/#/index', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissBlockingUi(page);
    await sleep(600);
    const homeAr = page.getByText('AdvancedResearch', { exact: true }).first();
    if (await homeAr.isVisible().catch(() => false)) {
      await homeAr.click().catch(() => {});
      await sleep(1000);
      clicked = true;
      logProgress('clicked AdvancedResearch on index');
    }
  } else {
    logProgress('clicked 新建聊天');
    await sleep(1200);
  }

  // 验证：用户消息应变少/清空，或标题不再是监控专用会话
  const usersAfter = await countUserMessages(page);
  const title = await page.locator('main').innerText().catch(() => '');
  const stillOnMonitor = /【自动化测试】|基础功能/.test(title) && usersAfter > 20;
  if (stillOnMonitor) {
    logProgress(`new chat may have failed users=${usersBefore}->${usersAfter}, retry click`);
    await clickNewChatButton(page);
    await sleep(1500);
  } else {
    logProgress(`new chat view users=${usersBefore}->${usersAfter}`);
  }
}

async function ensureChatReady(page) {
  await loginIfNeeded(page);
  await assertConversationAuthenticated(page);
  await dismissBlockingUi(page);
  // 必须真正新建会话，避免落入监控超长会话
  await forceNewChat(page);
  await dismissBlockingUi(page);
  await activateChatInput(page);
  await chooseAdvancedResearch(page);
  await activateChatInput(page);
  await dismissBlockingUi(page);

  const input = page.locator('textarea[placeholder*="输入关键字"], textarea').last();
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  if (await input.isDisabled().catch(() => false)) {
    await chooseAdvancedResearch(page);
    await page.waitForTimeout(800);
  }
  if (await input.isDisabled().catch(() => false)) {
    throw new Error('聊天输入框仍不可用（disabled）；请检查登录态或页面是否改版');
  }

  // 仍停在超长监控会话则硬失败，避免假发送
  const users = await countUserMessages(page);
  if (users > 30) {
    throw new Error(`未能离开旧会话（当前 user 气泡约 ${users} 条）。请确认「新建聊天」按钮可用`);
  }
  logProgress(`chat ready users=${users}`);
}

async function countUserMessages(page) {
  return page.locator('[data-role="user"]').count().catch(() => 0);
}

async function pageHasUserPrompt(page, prompt) {
  const needle = prompt.slice(0, 36);
  // 用户气泡里出现问题原文（排除仍停在 textarea 的情况）
  return page.locator('[data-role="user"]').evaluateAll((nodes, text) => (
    nodes.some((n) => (n.innerText || '').includes(text))
  ), needle).catch(() => false);
}

/**
 * 发送问题：必须以「用户气泡中出现问题原文」为准确认发出。
 * 仅输入框变空不足以证明（误点空发送也会清空）。
 */
async function sendQuestion(page, prompt) {
  const input = page.locator('textarea[placeholder*="输入关键字"], textarea').last();
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  if (await input.isDisabled().catch(() => false)) {
    await activateChatInput(page);
    await chooseAdvancedResearch(page);
  }

  const usersBefore = await countUserMessages(page);
  const sendBtn = page.locator('button[class*="chat-input-send"]').last();
  const needle = prompt.slice(0, 36);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await dismissBlockingUi(page);
    await input.click({ timeout: 5_000 });
    await input.fill('');
    // 使用 pressSequentially 更接近真实输入，兼容受控组件
    try {
      await input.fill(prompt);
    } catch {
      await input.pressSequentially(prompt, { delay: 1 });
    }
    let value = await input.inputValue().catch(() => '');
    if (!value.includes(needle.slice(0, 12))) {
      logProgress(`fill weak attempt=${attempt} valueLen=${value.length}, retry type`);
      await input.click();
      await input.fill('');
      await input.pressSequentially(prompt.slice(0, 500), { delay: 1 });
      value = await input.inputValue().catch(() => '');
    }
    if (!value || value.length < 8) {
      logProgress(`fill failed attempt=${attempt}`);
      continue;
    }
    logProgress(`filled attempt=${attempt} valueLen=${value.length}`);

    if ((await sendBtn.count()) > 0) {
      await sendBtn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
      if (await sendBtn.isEnabled().catch(() => false)) {
        await sendBtn.click({ force: true });
        logProgress(`clicked send attempt=${attempt}`);
      } else {
        await input.press('Enter');
        logProgress(`send disabled, Enter attempt=${attempt}`);
      }
    } else {
      await input.press('Enter');
      logProgress(`no send btn, Enter attempt=${attempt}`);
    }

    const confirmDeadline = Date.now() + 12_000;
    while (Date.now() < confirmDeadline) {
      const usersNow = await countUserMessages(page);
      // 必须：用户气泡数量增加，且最新/任一气泡含本题原文（避免旧会话误匹配）
      if (usersNow > usersBefore && (await pageHasUserPrompt(page, prompt))) {
        logProgress(`send confirmed attempt=${attempt} users=${usersBefore}->${usersNow}`);
        return usersBefore;
      }
      await sleep(400);
    }
    // 兜底：最新 user 气泡必须含本题原文
    const latestUser = await page.locator('[data-role="user"]').last().innerText().catch(() => '');
    if (latestUser.includes(needle) && (await countUserMessages(page)) > usersBefore) {
      logProgress(`send confirmed via latest user attempt=${attempt}`);
      return usersBefore;
    }
    logProgress(`send not confirmed attempt=${attempt} (no new user bubble with prompt)`);
  }
  throw new Error('问题未能发送成功：页面用户消息中未出现问题原文');
}

function cleanAnswerText(text) {
  return String(text || '')
    .replace(/秋月白为您服务~|重试|删除|复制|收藏|编辑|生成中|Generating/gi, '')
    .replace(/\d{1,2}\/\d{1,2}\/\d{4}[^\n]*/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T[^\n]*/g, '')
    .trim();
}

async function answerAfterLatestUser(page, usersBefore, prompt = '') {
  const needle = prompt ? prompt.slice(0, 36) : '';
  // 以包含本次 prompt 的 user 消息为锚点，取其后面的 assistant
  const byPrompt = await page.locator('[data-role]').evaluateAll((nodes, text) => {
    if (!text) return '';
    const roles = nodes.map((node) => ({
      role: node.getAttribute('data-role'),
      text: node.innerText || '',
      md: node.querySelector('.markdown-body')?.innerText?.trim() || '',
      el: node,
    }));
    let anchor = -1;
    for (let i = roles.length - 1; i >= 0; i -= 1) {
      if (roles[i].role === 'user' && roles[i].text.includes(text)) {
        anchor = i;
        break;
      }
    }
    if (anchor < 0) return '';
    for (let i = anchor + 1; i < roles.length; i += 1) {
      if (roles[i].role === 'assistant') {
        const md = roles[i].md;
        const raw = (roles[i].text || '').replace(/秋月白为您服务~|重试|删除|复制|收藏|编辑|\d{1,2}\/\d{1,2}\/\d{4}.*$/gm, '').trim();
        return md || raw;
      }
    }
    return '';
  }, needle).catch(() => '');
  if (byPrompt) return cleanAnswerText(byPrompt);

  // 回退：usersBefore 之后的 assistant
  const byRole = await page.locator('[data-role]').evaluateAll((nodes, minimumUsers) => {
    const users = nodes.filter((node) => node.getAttribute('data-role') === 'user');
    if (users.length <= minimumUsers) return '';
    const user = users.at(-1);
    const start = nodes.indexOf(user);
    const assistant = nodes.slice(start + 1).find((node) => node.getAttribute('data-role') === 'assistant');
    return assistant?.querySelector('.markdown-body')?.innerText.trim()
      || assistant?.innerText?.trim()
      || '';
  }, usersBefore).catch(() => '');
  if (byRole) return cleanAnswerText(byRole);

  const assistants = page.locator('[data-role="assistant"]');
  const count = await assistants.count().catch(() => 0);
  if (count === 0) return '';
  const last = assistants.nth(count - 1);
  const md = last.locator('.markdown-body').last();
  if ((await md.count()) > 0) return cleanAnswerText(await md.innerText().catch(() => ''));
  return cleanAnswerText(await last.innerText().catch(() => ''));
}

async function waitForAnswer(page, usersBefore, prompt = '') {
  const deadline = Date.now() + ANSWER_TIMEOUT;
  const firstDeadline = Date.now() + FIRST_ANSWER_TIMEOUT;
  let previous = '';
  let unchangedAt = Date.now();
  let planSince = 0;
  let tick = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    tick += 1;
    const latest = await answerAfterLatestUser(page, usersBefore, prompt);
    // 过短/仅欢迎语：视为尚未真正开始回答（避免 29 字占位卡死 15 分钟）
    const tooShort = !latest || latest.length < 40;
    if (tooShort) {
      if (Date.now() >= firstDeadline) {
        throw new Error(`首次有效回答等待超时（${Math.round(FIRST_ANSWER_TIMEOUT / 1000)}s）。可能未真正发出问题、仅有欢迎语或登录态异常`);
      }
      if (tick % 4 === 0) {
        logProgress(`waiting_for_first_answer elapsed=${Math.round((Date.now() - (firstDeadline - FIRST_ANSWER_TIMEOUT)) / 1000)}s chars=${latest ? latest.length : 0}`);
      }
      continue;
    }
    if (latest !== previous) {
      previous = latest;
      unchangedAt = Date.now();
      planSince = RESEARCH_IN_PROGRESS.test(latest) && latest.length < MIN_SAVED_ANSWER_CHARS ? (planSince || Date.now()) : 0;
      logProgress(`streaming chars=${latest.length}`);
      continue;
    }
    const isShortPlan = RESEARCH_IN_PROGRESS.test(latest) && latest.length < MIN_SAVED_ANSWER_CHARS;
    if (isShortPlan) {
      if (!planSince) planSince = Date.now();
      if (Date.now() - planSince >= RESEARCH_PLAN_STALL_TIMEOUT) {
        throw new Error(`研究计划停滞超时（${Math.round(RESEARCH_PLAN_STALL_TIMEOUT / 1000)}s），平台未产出最终回答`);
      }
      if (tick % 4 === 0) logProgress(`research_in_progress chars=${latest.length} stalled=${Math.round((Date.now() - planSince) / 1000)}s`);
      continue;
    }
    planSince = 0;
    if (latest.length >= 40 && Date.now() - unchangedAt >= STABLE_MS) {
      logProgress(`answer_stable chars=${latest.length}`);
      return latest;
    }
    if (tick % 4 === 0) logProgress(`stabilizing chars=${latest.length} stableMs=${Date.now() - unchangedAt}`);
  }
  // 超时前若已有较长回答，直接返回，避免白跑
  if (previous && previous.length >= MIN_SAVED_ANSWER_CHARS) {
    logProgress(`timeout_but_return_partial chars=${previous.length}`);
    return previous;
  }
  throw new Error(`回答等待超时（${Math.round(ANSWER_TIMEOUT / 60000)} 分钟）`);
}

async function loadJob() {
  const jobPath = arg('job');
  if (jobPath) {
    const raw = JSON.parse(await fs.readFile(path.resolve(jobPath), 'utf8'));
    if (!raw.prompt || !raw.questionId) throw new Error('job 缺少 questionId/prompt');
    return raw;
  }
  const questionId = arg('question-id') || process.env.RESEARCH_QUESTION_ID;
  if (!questionId) throw new Error('需要 --question-id 或 --job');
  const known = getResearchQuestion(questionId);
  if (!known) throw new Error(`未知 questionId: ${questionId}`);
  return { ...known, questionId: known.id };
}

async function loadSessionStorageEntries(storageStatePath) {
  const sessionPath = process.env.SCIENCE42_SESSION_STATE
    || path.join(path.dirname(storageStatePath), 'science42-session.json');
  try {
    const raw = await fs.readFile(sessionPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // optional
  }
  return null;
}

async function main() {
  const job = await loadJob();
  const baseUrl = getTargetUrl();
  const storageState = getStorageStatePath();
  try {
    await fs.access(storageState);
  } catch {
    throw new Error(`未找到登录态 ${storageState}，请先在 science42-synthetic-monitor 执行 npm run auth:setup`);
  }

  const started = Date.now();
  console.log(`[start] question=${job.questionId || job.id} url=${baseUrl} storage=${storageState}`);

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  let page;
  try {
    const context = await browser.newContext({
      storageState,
      baseURL: baseUrl,
    });
    const sessionEntries = await loadSessionStorageEntries(storageState);
    if (sessionEntries && Object.keys(sessionEntries).length > 0) {
      await context.addInitScript((entries) => {
        for (const [key, value] of Object.entries(entries)) {
          try { sessionStorage.setItem(key, String(value)); } catch { /* ignore */ }
        }
      }, sessionEntries);
    }

    page = await context.newPage();
    await ensureChatReady(page);
    const usersBefore = await sendQuestion(page, job.prompt);
    logProgress('question sent, waiting answer');
    const answer = await waitForAnswer(page, usersBefore, job.prompt);
    const durationMs = Date.now() - started;
    const result = {
      ok: true,
      questionId: job.questionId || job.id,
      category: job.category || null,
      topic: job.topic || null,
      domain: job.domain || null,
      variant: job.variant ?? null,
      userContent: job.prompt,
      assistantContent: answer,
      answerChars: answer.length,
      durationMs,
      collectedAt: new Date().toISOString(),
    };
    console.log(`[done] chars=${answer.length} durationMs=${durationMs}`);
    emitResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    if (page) {
      const shot = path.resolve('results', `ask-failure-${Date.now()}.png`);
      await fs.mkdir(path.dirname(shot), { recursive: true }).catch(() => {});
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      console.error(`[error] screenshot=${shot}`);
    }
    emitResult({
      ok: false,
      questionId: job.questionId || job.id,
      category: job.category || null,
      topic: job.topic || null,
      domain: job.domain || null,
      variant: job.variant ?? null,
      userContent: job.prompt,
      assistantContent: '',
      answerChars: 0,
      durationMs: Date.now() - started,
      error: message,
      collectedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  emitResult({
    ok: false,
    questionId: arg('question-id') || 'unknown',
    userContent: '',
    assistantContent: '',
    answerChars: 0,
    durationMs: 0,
    error: error instanceof Error ? error.message : String(error),
    collectedAt: new Date().toISOString(),
  });
  process.exit(1);
});

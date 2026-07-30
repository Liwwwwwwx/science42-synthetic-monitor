import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = process.env.SCIENCE42_MONITOR_URL || process.env.SCIENCE42_BASE_URL || 'http://192.168.0.112:23191';
const entryPath = process.env.SCIENCE42_ENTRY_PATH || '/#/cases';
const chatPath = process.env.SCIENCE42_CHAT_PATH || '/#/chat';
const storageState = process.env.SCIENCE42_STORAGE_STATE || 'playwright/.auth/science42.json';
const maxTaskMs = Number(process.env.MAX_TASK_MS || 75_000);
const webhook = process.env.ALERT_WEBHOOK_URL;
const artifactRoot = process.env.MONITOR_ARTIFACT_DIR || 'artifacts/core-monitor';
const stateFile = path.join(artifactRoot, 'monitor-state.json');

const now = new Date();
const runId = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
const runDir = path.join(artifactRoot, runId);
await fs.mkdir(runDir, { recursive: true });

async function readState() {
  try { return JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch { return { consecutiveFailures: 0, consecutiveSuccesses: 0, alertOpen: false }; }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

async function sendAlert(payload) {
  if (!webhook) return { sent: false, reason: 'ALERT_WEBHOOK_URL not configured' };
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { sent: response.ok, status: response.status };
}

async function runCheck() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const started = Date.now();
  let responseStatus = null;
  let result = null;
  try {
    await page.goto(new URL(entryPath, baseUrl).href, { waitUntil: 'domcontentloaded' });
    const password = page.locator('input[placeholder="密码"], input[type="password"]');
    if (await password.count() > 0) throw new Error('登录状态失效或未提供 storageState');
    const returnChat = page.getByRole('button', { name: /返回聊天/ });
    if (await returnChat.count() === 1) await returnChat.click();
    else await page.goto(new URL(chatPath, baseUrl).href, { waitUntil: 'domcontentloaded' });
    const input = page.locator('textarea, input[placeholder*="提问"], input[placeholder*="问题"]');
    await input.waitFor({ state: 'visible', timeout: 20_000 });
    const question = `核心流程监控 ${now.toISOString()}：只回答“通过”。`;
    await input.fill(question);
    const responsePromise = page.waitForResponse(r => r.url().includes('/api/') && r.request().method() !== 'OPTIONS', { timeout: 10_000 }).catch(() => null);
    await input.press('Enter');
    let body = '';
    let tail = '';
    const deadline = Date.now() + maxTaskMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      body = await page.locator('main').innerText();
      const questionIndex = body.lastIndexOf(question);
      tail = questionIndex >= 0 ? body.slice(questionIndex + question.length) : '';
      if (questionIndex >= 0 && tail.includes('秋月白') && !/生成中|Generating/.test(tail)) break;
    }
    if (!tail.includes('秋月白')) throw new Error('75 秒内未发现本次监控问题对应的回答');
    const firstMs = Date.now() - started;
    const response = await responsePromise;
    responseStatus = response?.status() ?? null;
    if (/生成中|Generating/.test(tail)) throw new Error('回答仍处于生成中');
    if (/失败|超时|failed/i.test(tail)) throw new Error('页面显示失败或超时状态');
    result = { status: 'completed', firstMs, totalMs: Date.now() - started, httpStatus: responseStatus, question };
  } finally {
    await page.screenshot({ path: path.join(runDir, 'page.png'), fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: path.join(runDir, 'trace.zip') }).catch(() => {});
    await browser.close();
  }
  return result;
}

const state = await readState();
let ok = false;
let error = null;
try { await runCheck(); ok = true; }
catch (e) { error = e instanceof Error ? e.message : String(e); }

const record = { runId, time: now.toISOString(), environment: baseUrl, ok, error, evidence: runDir };
await fs.writeFile(path.join(runDir, 'result.json'), JSON.stringify(record, null, 2), 'utf8');

let alertResult = { sent: false, reason: 'not needed' };
if (ok) {
  state.consecutiveFailures = 0;
  state.consecutiveSuccesses = (state.consecutiveSuccesses || 0) + 1;
  if (state.alertOpen && state.consecutiveSuccesses >= 2) {
    alertResult = await sendAlert({ title: '[Science42 恢复] 平台核心流程恢复', time: now.toISOString(), environment: baseUrl, consecutiveSuccesses: state.consecutiveSuccesses });
    state.alertOpen = false;
  }
} else {
  state.consecutiveSuccesses = 0;
  state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
  if (state.consecutiveFailures >= 2 && !state.alertOpen) {
    alertResult = await sendAlert({ title: '[Science42 P1] 平台核心流程异常', time: now.toISOString(), environment: baseUrl, consecutiveFailures: state.consecutiveFailures, error, evidence: runDir });
    state.alertOpen = true;
  }
}
state.lastRun = record;
state.lastAlert = alertResult;
await writeState(state);
console.log(JSON.stringify({ ...record, alert: alertResult }));
if (!ok) process.exitCode = 1;

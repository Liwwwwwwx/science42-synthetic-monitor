import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = process.env.SCIENCE42_MONITOR_URL || process.env.SCIENCE42_BASE_URL;
const entryPath = process.env.SCIENCE42_ENTRY_PATH || '/#/cases';
const chatPath = process.env.SCIENCE42_CHAT_PATH || '/#/chat';
const storageState = process.env.SCIENCE42_STORAGE_STATE || 'shared/auth/.auth/science42.json';
const maxTaskMs = Number(process.env.MAX_TASK_MS || 75_000);
const artifactRoot = process.env.MONITOR_ARTIFACT_DIR || 'results/runs/core_link';
const spoolRoot = process.env.MONITOR_SPOOL_DIR || 'results/spool';
const reportUrl = process.env.SYNTHETIC_MONITOR_REPORT_URL || '';
const runnerId = process.env.SYNTHETIC_MONITOR_RUNNER_ID || '';
const runnerToken = process.env.SYNTHETIC_MONITOR_RUNNER_TOKEN || '';
const localArtifactRetentionDays = Number(process.env.LOCAL_ARTIFACT_RETENTION_DAYS || 7);
const runId = crypto.randomUUID(); const runDir = path.join(artifactRoot, runId);
function makeCheck(key, status, started, extra = {}) { return { key, status, durationMs: Date.now() - started, errorCode: extra.errorCode || null, message: extra.message || null }; }
function classify(error) { const message = String(error?.message || error); if (/登录状态失效|storageState|登录/i.test(message)) return 'AUTH_EXPIRED'; if (/100\/100|对话已达上限/i.test(message)) return 'CONVERSATION_LIMIT'; if (/timeout|超时/i.test(message)) return 'TIMEOUT'; if (/locator|input/i.test(message)) return 'SELECTOR_UNAVAILABLE'; return 'CHECK_FAILED'; }
function brief(error) { return String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 500); }
async function ensureChat(page) { await page.goto(new URL(entryPath, baseUrl).href, { waitUntil: 'domcontentloaded' }); if (await page.locator('input[placeholder="密码"], input[type="password"]').count() > 0) throw new Error('登录状态失效或未提供 storageState'); const returnChat = page.getByRole('button', { name: /返回聊天/ }); if (await returnChat.count() === 1) await returnChat.click(); else await page.goto(new URL(chatPath, baseUrl).href, { waitUntil: 'domcontentloaded' }); const blockingModal = page.locator('.ant-modal-wrap:visible, [role="dialog"]:visible').filter({ hasText: /套餐|科学探索永无止境/ }); if (await blockingModal.count()) { const close = blockingModal.locator('.ant-modal-close, button[aria-label="Close"]'); if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape'); } const input = page.locator('textarea, input[placeholder*="提问"], input[placeholder*="问题"]').last(); await input.waitFor({ state: 'visible', timeout: 20_000 }); return input; }
async function sendReport(report, evidence) { if (!reportUrl || !runnerId || !runnerToken) throw new Error('Synthetic report endpoint or runner credentials are not configured'); const form = new FormData(); form.set('payload', JSON.stringify(report)); for (const [key, file] of Object.entries(evidence)) if (file) form.set(key, new Blob([await fs.readFile(file)], { type: key === 'trace' ? 'application/zip' : 'image/png' }), path.basename(file)); const response = await fetch(`${reportUrl.replace(/\/$/, '')}/api/synthetic-monitoring/runners/${encodeURIComponent(runnerId)}/runs`, { method: 'POST', headers: { 'X-Synthetic-Monitor-Token': runnerToken }, body: form, signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`Synthetic report rejected: HTTP ${response.status}`); }
async function spool(report, evidence) { await fs.mkdir(spoolRoot, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(spoolRoot, `${report.finishedAt.replaceAll(':', '-')}-${report.runId}.json`), JSON.stringify({ report, evidence }), { mode: 0o600 }); }
async function flushSpool() { if (!reportUrl || !runnerId || !runnerToken) return; for (const file of (await fs.readdir(spoolRoot).catch(() => [])).filter((name) => name.endsWith('.json')).sort()) { try { const item = JSON.parse(await fs.readFile(path.join(spoolRoot, file), 'utf8')); await sendReport(item.report, item.evidence); await fs.unlink(path.join(spoolRoot, file)); } catch {} } }
async function protectedArtifactDirectories() {
  const protectedDirs = new Set();
  for (const file of (await fs.readdir(spoolRoot).catch(() => [])).filter((name) => name.endsWith('.json'))) {
    try {
      const { evidence = {} } = JSON.parse(await fs.readFile(path.join(spoolRoot, file), 'utf8'));
      for (const evidencePath of Object.values(evidence)) if (typeof evidencePath === 'string') protectedDirs.add(path.dirname(evidencePath));
    } catch {}
  }
  return protectedDirs;
}
async function cleanupLocalArtifacts({ delivered, status }) {
  const protectedDirs = await protectedArtifactDirectories();
  if (status === 'passed' && delivered) {
    await fs.copyFile(path.join(runDir, 'page.png'), path.join(artifactRoot, 'latest-success.png')).catch(() => {});
    await fs.rm(runDir, { recursive: true, force: true });
  }
  const cutoff = Date.now() - localArtifactRetentionDays * 86400_000;
  for (const entry of await fs.readdir(artifactRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(artifactRoot, entry.name);
    if (candidate === runDir || protectedDirs.has(candidate)) continue;
    const resultPath = path.join(candidate, 'result.json');
    try {
      const report = JSON.parse(await fs.readFile(resultPath, 'utf8'));
      if (report.status === 'passed' || new Date(report.finishedAt).getTime() < cutoff) await fs.rm(candidate, { recursive: true, force: true });
    } catch {}
  }
}
if (!baseUrl) throw new Error('SCIENCE42_MONITOR_URL or SCIENCE42_BASE_URL is required'); await fs.mkdir(runDir, { recursive: true }); await flushSpool();
const startedAt = new Date(); const checks = []; let page; let context; let browser; let question; let canary;
try { browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' }); context = await browser.newContext({ storageState }); await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); page = await context.newPage(); let input; const authAt = Date.now(); try { input = await ensureChat(page); checks.push(makeCheck('auth_state', 'passed', authAt)); } catch (error) { checks.push(makeCheck('auth_state', 'failed', authAt, { errorCode: classify(error), message: brief(error) })); }
  if (input) { const streamAt = Date.now(); try { canary = `SCIENCE42-CANARY-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; question = `合成监控 ${runId}：请在回复中包含标记 ${canary}。`; await input.fill(question); const responsePromise = page.waitForResponse((response) => response.url().includes('/api/') && response.request().method() !== 'OPTIONS', { timeout: 10_000 }).catch(() => null); const send = page.locator('button[class*="chat-input-send"]'); if (await send.count()) await send.last().click(); else await input.press('Enter'); let tail = ''; const deadline = Date.now() + maxTaskMs; while (Date.now() < deadline) { await page.waitForTimeout(500); const body = await page.locator('main').innerText(); const index = body.lastIndexOf(question); tail = index >= 0 ? body.slice(index + question.length) : ''; if (index >= 0 && tail.includes(canary) && !/生成中|Generating/i.test(tail)) break; } const response = await responsePromise; if (!tail.includes(canary)) throw new Error('当前问题在限定时间内没有返回 Canary 标记'); if (/生成中|Generating|失败|超时|failed/i.test(tail)) throw new Error('回答未完成或页面显示失败状态'); checks.push(makeCheck('chat_stream', 'passed', streamAt, { message: response ? `HTTP ${response.status()}` : null })); } catch (error) { checks.push(makeCheck('chat_stream', 'failed', streamAt, { errorCode: classify(error), message: brief(error) })); }
    const restoreAt = Date.now(); if (checks[1]?.status === 'passed') { try { await page.reload({ waitUntil: 'domcontentloaded' }); await ensureChat(page); const text = await page.locator('main').innerText(); if (!text.includes(question) || !text.includes(canary)) throw new Error('刷新后未恢复本次会话'); checks.push(makeCheck('session_restore', 'passed', restoreAt)); } catch (error) { checks.push(makeCheck('session_restore', 'failed', restoreAt, { errorCode: classify(error), message: brief(error) })); } } else checks.push(makeCheck('session_restore', 'error', restoreAt, { errorCode: 'PREREQUISITE_FAILED', message: 'chat_stream failed' }));
  } else { checks.push(makeCheck('chat_stream', 'error', Date.now(), { errorCode: 'PREREQUISITE_FAILED', message: 'auth_state failed' })); checks.push(makeCheck('session_restore', 'error', Date.now(), { errorCode: 'PREREQUISITE_FAILED', message: 'auth_state failed' })); }
} catch (error) { for (const key of ['auth_state', 'chat_stream', 'session_restore']) if (!checks.some((item) => item.key === key)) checks.push(makeCheck(key, 'error', Date.now(), { errorCode: classify(error), message: brief(error) })); } finally { const screenshot = path.join(runDir, 'page.png'); const trace = path.join(runDir, 'trace.zip'); await page?.screenshot({ path: screenshot, fullPage: true }).catch(() => {}); await context?.tracing.stop({ path: trace }).catch(() => {}); await browser?.close().catch(() => {}); }
const status = checks.every((item) => item.status === 'passed') ? 'passed' : (checks.some((item) => item.status === 'error') ? 'error' : 'failed'); const report = { runId, sequence: Number(process.env.SYNTHETIC_MONITOR_SEQUENCE || Date.now()), startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), status, durationMs: Date.now() - startedAt.getTime(), checks, errorSummary: status === 'passed' ? null : checks.filter((item) => item.status !== 'passed').map((item) => `${item.key}:${item.errorCode}`).join(', ') }; await fs.writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2)); const evidence = status === 'passed' ? { screenshot: path.join(runDir, 'page.png') } : { screenshot: path.join(runDir, 'page.png'), trace: path.join(runDir, 'trace.zip') }; let delivered = false; try { await sendReport(report, evidence); delivered = true; } catch { await spool(report, evidence); } await cleanupLocalArtifacts({ delivered, status }).catch(() => {}); console.log(JSON.stringify({ runId, status, checks: checks.map(({ key, status: checkStatus, errorCode }) => ({ key, status: checkStatus, errorCode })) })); if (status !== 'passed') process.exitCode = 1;

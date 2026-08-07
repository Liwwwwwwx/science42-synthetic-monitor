#!/usr/bin/env node
/**
 * 案例业务链路的无浏览器批量 Runner。
 * 保留 run-cases.mjs（Playwright）作为页面 UI 冒烟；本脚本只验证真实 WS 工作流与持久化结果。
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getTargetUrl } from '../shared/config/project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOBS_PATH = path.join(ROOT, 'shared/config/case-ws-jobs.json');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const match = args.find((item) => item.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const CATEGORY = opt('category', 'physics').toLowerCase();
const INDICES = opt('indices', '').split(',').filter(Boolean).map(Number);
const MAX_PARALLEL = CATEGORY === 'material' ? 2 : 3;
const PARALLEL = Math.min(Math.max(Number(opt('parallel', 1)) || 1, 1), MAX_PARALLEL);
const ANSWER_TIMEOUT_MS = Number(opt('timeout', CATEGORY === 'data' ? 660_000 : 300_000));
const PERSISTENCE_TIMEOUT_MS = Number(opt('persistence-timeout', 60_000));
const POLL_MS = 2_000;
const DRY = args.includes('--dry');

function usage() {
  console.log('Usage: npm run run:cases-ws -- --category=physics|data|material --indices=1,2 [--parallel=1-3] [--dry]');
}

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function findString(value, keys) {
  const object = asObject(value);
  if (!object) return '';
  for (const key of keys) if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  for (const child of Object.values(object)) { const found = findString(child, keys); if (found) return found; }
  return '';
}
function findArray(value, key) {
  const object = asObject(value);
  if (!object) return [];
  if (Array.isArray(object[key])) return object[key];
  for (const child of Object.values(object)) { const found = findArray(child, key); if (found.length) return found; }
  return [];
}
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status} ${new URL(url).pathname}`);
  return data;
}
async function authenticate(baseUrl) {
  if (!process.env.SCIENCE42_USER || !process.env.SCIENCE42_PASSWORD) throw new Error('缺少 SCIENCE42_USER/SCIENCE42_PASSWORD');
  const login = await jsonRequest(`${baseUrl}/api/user/account_login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: process.env.SCIENCE42_USER, password: process.env.SCIENCE42_PASSWORD }),
  });
  const token = findString(login, ['token', 'access_token', 'accessToken']);
  const userName = findString(login, ['user_name', 'username', 'userName', 'account_name', 'account']);
  if (!token || !userName) throw new Error('测试账号登录响应缺少 token 或 user_name');
  return { token, userName };
}
async function resolveConversationIds(baseUrl, token, count) {
  const data = await jsonRequest(`${baseUrl}/api/conversation/conversations?page=1&limit=100`, { headers: { authorization: `Bearer ${token}` } });
  const ids = [...new Set(findArray(data, 'conversations')
    .map((item) => findString(item, ['external_id', 'externalId', 'conversation_id', 'conversationId', 'id']))
    .filter(Boolean))];
  if (ids.length < count) throw new Error(`可用会话不足：并发 ${count} 需要 ${count} 个不同 conversation_id，当前仅 ${ids.length} 个`);
  return ids.slice(0, count);
}
async function resolveWsUrl(baseUrl) {
  const data = await jsonRequest(`${baseUrl}/api/getWsUrl`);
  if (typeof data.message !== 'string' || !/^wss?:\/\//.test(data.message)) throw new Error('产品未提供有效 WebSocket 地址');
  return data.message;
}
function isAssistant(message) { return message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim(); }
function messageFingerprint(message) {
  const id = findString(message, ['id', 'message_id', 'messageId', 'external_id', 'externalId']);
  return `${id || message?.role || 'unknown'}\u0000${String(message?.content || '').trim()}`;
}
async function loadConversationMessages(baseUrl, token, conversationId) {
  const data = await jsonRequest(`${baseUrl}/api/conversation/conversations/${encodeURIComponent(conversationId)}/messages`, { headers: { authorization: `Bearer ${token}` } });
  return findArray(data, 'messages');
}
async function waitForPersistedAnswer(baseUrl, token, conversationId, clientMessageId, beforeSnapshot) {
  const deadline = Date.now() + PERSISTENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const messages = await loadConversationMessages(baseUrl, token, conversationId);
    const direct = [...messages].reverse().find((message) => message?.client_message_id === clientMessageId && isAssistant(message));
    if (direct) return String(direct.content).trim();

    // Science42 当前仅稳定地把 client_message_id 写到用户消息；assistant 记录常不继承该字段。
    // 每个 worker 独占一个会话，因此以该用户消息为锚点，取下一条用户消息之前的最后一条 assistant，
    // 可避免回退到旧历史回答或并发请求的回答。
    const anchor = messages.findIndex((message) => message?.client_message_id === clientMessageId);
    if (anchor >= 0) {
      const following = messages.slice(anchor + 1);
      const nextUser = following.findIndex((message) => message?.role === 'user');
      const scoped = nextUser >= 0 ? following.slice(0, nextUser) : following;
      const answer = [...scoped].reverse().find(isAssistant);
      if (answer) return String(answer.content).trim();
    }
    // 部分部署的历史接口会丢弃 client_message_id。worker 独占会话，因此只能接受
    // 发送前快照之外新增/更新的 assistant；绝不回退到任意历史最后一条回答。
    const answer = [...messages].reverse().find((message) => isAssistant(message) && !beforeSnapshot.has(messageFingerprint(message)));
    if (answer) return String(answer.content).trim();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('未找到本次请求新增或更新的持久化 assistant 回复');
}
function sendAndWait(wsUrl, payload) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const eventTypes = new Set();
    let frameCount = 0;
    let opened = false;
    let finished = false;
    const timer = setTimeout(() => finish(new Error(opened
      ? `WebSocket 已连接但回答超时（${Math.round(ANSWER_TIMEOUT_MS / 1000)}s）`
      : `WebSocket 连接超时（${Math.round(ANSWER_TIMEOUT_MS / 1000)}s）`)), ANSWER_TIMEOUT_MS);
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(1000, error ? 'answer timeout' : 'answer completed'); } catch { /* noop */ }
      if (error) reject(error); else resolve({ frameCount, eventTypes: [...eventTypes] });
    };
    // Node 22 的 WebSocket 是 EventTarget；不用浏览器属性回调，避免 open 事件未挂上的兼容性问题。
    socket.addEventListener('open', () => { opened = true; socket.send(JSON.stringify(payload)); });
    socket.addEventListener('message', (event) => {
      frameCount += 1;
      const raw = String(event.data || '');
      try { const parsed = JSON.parse(raw); eventTypes.add(parsed?.type ? String(parsed.type) : 'json'); } catch { eventTypes.add('text'); }
      if (raw.trim() === '[end]' || /【.*(?:已结束|已完成):.*】/.test(raw)) finish();
    });
    socket.addEventListener('error', () => finish(new Error('WebSocket 连接或传输失败')));
    socket.addEventListener('close', () => { if (!finished && frameCount > 0) finish(); });
  });
}

const DATA_REQUIRED_PHRASES = ['CAD 组装与建模任务', '正在构思装配结构规划', '规划已交付，开始编写底层代码', '正在生成几何实体，请稍候'];
function stepHasCodeBlock(content, step) {
  const next = step + 1;
  const section = new RegExp(`Step\\s*${step}[\\s.、:：][\\s\\S]*?(?=Step\\s*${next}[\\s.、:：]|$)`, 'i').exec(content)?.[0] || '';
  return /```|<pre\b|class=["'][^"']*code/i.test(section);
}
function validateAnswer(job, content) {
  const checks = [{ key: 'assistant_reply', ok: Boolean(content.trim()), detail: '本次请求已关联到持久化 assistant 回复' }];
  if (CATEGORY === 'physics') {
    const steps = [1, 2, 3, 4, 5, 6];
    checks.push({ key: 'steps', ok: steps.every((step) => new RegExp(`Step\\s*${step}[\\s.、:：]`, 'i').test(content)), detail: 'Step 1-6' });
    checks.push({ key: 'code_blocks', ok: stepHasCodeBlock(content, 5) && stepHasCodeBlock(content, 6), detail: 'Step 5/6 代码块' });
    checks.push({ key: 'png', ok: /\.png\b|data:image\/png|!\[[^\]]*\]\([^)]*\.png/i.test(content), detail: 'PNG 产物' });
    checks.push({ key: 'complete', ok: /项目[\s\S]{0,160}执行完成/i.test(content), detail: '执行完成标记' });
  } else if (CATEGORY === 'data') {
    checks.push({ key: 'cad_flow', ok: DATA_REQUIRED_PHRASES.every((phrase) => content.includes(phrase)), detail: 'CAD 流程文案' });
    checks.push({ key: 'stl', ok: /\.stl(?:[?#]|$)|<<<STL_VIEWER:|STL 模型|>STL<|STL_VIEWER/i.test(content), detail: 'STL 产物' });
  } else {
    const retrieval = /中文检索项/.test(content) && /论文检索进度|检索概览|检索结果重排|文献检索/.test(content) && /综合回答/.test(content);
    const analysis = /材料名称核对|已入库性质|本轮建议|核心材料需求|候选材料|需求与瓶颈的关联/.test(content) && /追问推荐\s*[→>]?/.test(content);
    checks.push({ key: 'material_profile', ok: retrieval || analysis, detail: retrieval ? '检索综合型' : analysis ? '文本分析型' : '未识别材料 Profile' });
  }
  return checks;
}
async function runOne({ job, conversationId, baseUrl, token, userName }) {
  const started = Date.now();
  const beforeSnapshot = new Set((await loadConversationMessages(baseUrl, token, conversationId)).map(messageFingerprint));
  const clientMessageId = `case-ws-${crypto.randomUUID()}`;
  const payload = {
    action: 'send_message', conversation_id: conversationId, client_message_id: clientMessageId,
    message: { content: job.prompt }, user_name: userName, file_metadata: job.fileMetadata || [],
    taskid: `${conversationId}-${clientMessageId}`, team_type: job.teamType,
    ...(job.pdeImagePara ? { pde_image_para: job.pdeImagePara } : {}),
  };
  const wsUrl = await resolveWsUrl(baseUrl);
  const ws = await sendAndWait(wsUrl, payload);
  const answer = await waitForPersistedAnswer(baseUrl, token, conversationId, clientMessageId, beforeSnapshot);
  const checks = validateAnswer(job, answer);
  const failed = checks.filter((check) => !check.ok);
  return { status: failed.length ? 'FAILED' : 'PASSED', durationMs: Date.now() - started, checks, reason: failed.map((check) => check.detail).join('；') || '', ws, clientMessageId };
}

if (!['physics', 'data', 'material'].includes(CATEGORY) || INDICES.length === 0 || INDICES.some((value) => !Number.isInteger(value) || value < 1) || new Set(INDICES).size !== INDICES.length) {
  usage(); process.exit(1);
}
const config = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
const jobs = config?.categories?.[CATEGORY] || [];
const selected = INDICES.map((position) => jobs.find((job) => job.position === position) || { position, missing: true });
if (DRY) {
  for (const item of selected) console.log(item.missing ? `#${item.position} MISSING` : `#${item.position} ${item.title} team=${item.teamType}${item.pdeImagePara ? ' pde=yes' : ''}`);
  process.exit(selected.some((item) => item.missing) ? 1 : 0);
}
const baseUrl = getTargetUrl();
const { token, userName } = await authenticate(baseUrl);
const conversations = await resolveConversationIds(baseUrl, token, Math.min(PARALLEL, selected.length));
console.log(`[ws-batch] category=${CATEGORY} selected=${selected.length} parallel=${Math.min(PARALLEL, selected.length)} transport=websocket`);

let cursor = 0;
const results = [];
async function worker(slot) {
  while (cursor < selected.length) {
    const item = selected[cursor++];
    if (item.missing) {
      const result = { position: item.position, title: `案例 #${item.position}`, status: 'FAILED', reason: '该位置没有对应的已同步案例卡 WS 配置', durationMs: 0 };
      results.push(result); console.log(`[run ${slot}] #${result.position} ${result.title} → ${result.reason} (0s)`); continue;
    }
    const runStarted = Date.now();
    try {
      console.log(`[run ${slot}] ${item.title} 启动（WS 会话 ${slot}）`);
      console.log(`[ws] #${item.position} connecting team=${item.teamType}`);
      const result = await runOne({ job: item, conversationId: conversations[slot - 1], baseUrl, token, userName });
      results.push({ position: item.position, title: item.title, ...result });
      console.log(`[run ${slot}] #${item.position} ${item.title} → ${result.reason || result.status} (${Math.round(result.durationMs / 1000)}s)`);
      console.log(`[ws] #${item.position} frames=${result.ws.frameCount} types=${result.ws.eventTypes.join(',') || 'none'} request=${result.clientMessageId}`);
      console.log(`__CASE_WS_RESULT__${JSON.stringify({ position: item.position, executionMode: 'websocket', requestId: result.clientMessageId, frameCount: result.ws.frameCount, eventTypes: result.ws.eventTypes, checks: result.checks })}`);
    } catch (error) {
      const result = { position: item.position, title: item.title, status: 'FAILED', reason: error instanceof Error ? error.message : String(error), durationMs: Date.now() - runStarted };
      results.push(result); console.log(`[run ${slot}] #${item.position} ${item.title} → ${result.reason} (${Math.round(result.durationMs / 1000)}s)`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(PARALLEL, selected.length) }, (_, index) => worker(index + 1)));
const ordered = results.sort((a, b) => a.position - b.position);
const failed = ordered.filter((result) => result.status !== 'PASSED');
console.log(`通过 ${ordered.length - failed.length}/${ordered.length}`);
process.exit(failed.length ? 1 : 0);

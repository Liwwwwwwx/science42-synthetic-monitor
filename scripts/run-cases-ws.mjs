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
import { isAutomaticReloginAllowed, loadReusableWsAuth } from '../shared/auth/reusable-ws-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOBS_PATH = path.join(ROOT, 'shared/config/case-ws-jobs.json');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const match = args.find((item) => item.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const CATEGORY = opt('category', 'physics').toLowerCase();
const INDICES = opt('indices', '').split(',').filter(Boolean).map(Number);
const PARALLEL = 1;
const MAX_REQUEST_ATTEMPTS = 3;
// 15 秒仅作为 WebSocket 客户端的观察窗口：产品已接收的任务会继续执行，
// 不能因 WS 没有及时回帧就重复发送同一案例。
const SOCKET_OBSERVATION_MS = 15_000;
const INTER_CASE_DELAY_MS = 10_000;
const ANSWER_TIMEOUT_MS = Number(opt('timeout', CATEGORY === 'data' ? 660_000 : 300_000));
const PERSISTENCE_TIMEOUT_MS = Number(opt('persistence-timeout', CATEGORY === 'data' ? 660_000 : CATEGORY === 'material' ? 390_000 : 60_000));
const EMPTY_ASSISTANT_GRACE_MS = Number(opt('empty-assistant-grace', 90_000));
const POLL_MS = 2_000;
const DRY = args.includes('--dry');

function usage() {
  console.log('Usage: npm run run:cases-ws -- --category=physics|data|material --indices=1,2 [--dry]');
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
async function jsonRequest(url, options = {}, timeoutMs = 45_000) {
  const controller = new AbortController();
  const pathname = new URL(url).pathname;
  let timer;
  // 超时必须覆盖响应体读取；有些网关会很快返回响应头、却一直不结束 body。
  // 若只 race(fetch)，response.json() 会绕过超时并让批次永久停在预检阶段。
  const request = (async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}`);
    return data;
  })();
  // 部分网络栈在已建立 TLS 连接、但迟迟不返回响应头时不可靠地触发 AbortSignal.timeout；
  // 用 Promise.race 保证 runner 自身 45 秒后必然继续收敛，并中止底层请求释放连接。
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`HTTP 请求超时（${Math.ceil(timeoutMs / 1000)}s）${pathname}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
    // race 超时后 fetch 会异步 reject；显式消费，避免成为未处理的拒绝。
    request.catch(() => {});
  }
}
async function loginWithPassword(baseUrl) {
  if (!process.env.SCIENCE42_USER || !process.env.SCIENCE42_PASSWORD) throw new Error('缺少 SCIENCE42_USER/SCIENCE42_PASSWORD');
  const login = await jsonRequest(`${baseUrl}/api/user/account_login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: process.env.SCIENCE42_USER, password: process.env.SCIENCE42_PASSWORD }),
  });
  const token = findString(login, ['token', 'access_token', 'accessToken']);
  const userName = findString(login, ['user_name', 'username', 'userName', 'account_name', 'account']);
  if (!token || !userName) throw new Error('测试账号登录响应缺少 token 或 user_name');
  return { token, userName, source: 'password-login' };
}
async function authenticate(baseUrl) {
  const reusable = await loadReusableWsAuth(baseUrl);
  if (reusable) return reusable;
  if (!isAutomaticReloginAllowed()) {
    throw new Error('未找到可复用测试登录态：请配置 SCIENCE42_TOKEN/SCIENCE42_USER_NAME，或先执行一次 npm run auth:setup；如明确允许自动重登，设置 SCIENCE42_ALLOW_RELOGIN=true');
  }
  return loginWithPassword(baseUrl);
}
async function resolveConversationIds(baseUrl, token, count) {
  const data = await jsonRequest(`${baseUrl}/api/conversation/conversations?page=1&limit=100`, { headers: { authorization: `Bearer ${token}` } });
  const ids = [...new Set(findArray(data, 'conversations')
    .map((item) => findString(item, ['external_id', 'externalId', 'conversation_id', 'conversationId', 'id']))
    .filter(Boolean))];
  if (ids.length < count) throw new Error(`可用会话不足：串行执行仍需要一个有效 conversation_id，当前仅 ${ids.length} 个`);
  return ids.slice(0, count);
}
async function resolveWsUrl(baseUrl) {
  const data = await jsonRequest(`${baseUrl}/api/getWsUrl`);
  if (typeof data.message !== 'string' || !/^wss?:\/\//.test(data.message)) throw new Error('产品未提供有效 WebSocket 地址');
  return data.message;
}
/** 产品会把 quote/progress 等控制帧以 assistant message 持久化；它们不是可验收的业务回答。 */
function isAssistant(message) {
  if (message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()) return false;
  try {
    const parsed = JSON.parse(message.content);
    return !(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.type === 'string');
  } catch {
    return true;
  }
}
function messageFingerprint(message) {
  const id = findString(message, ['id', 'message_id', 'messageId', 'external_id', 'externalId']);
  return `${id || message?.role || 'unknown'}\u0000${String(message?.content || '').trim()}`;
}
function messageId(message) {
  return findString(message, ['id', 'message_id', 'messageId', 'external_id', 'externalId']);
}
function buildSourceRef({ conversationId, clientMessageId, assistant, content }) {
  const normalized = String(content || '').trim();
  return {
    version: 1,
    conversationId,
    clientMessageId,
    assistantMessageId: assistant ? messageId(assistant) || null : null,
    contentSha256: normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : null,
    contentLength: normalized.length,
    capturedAt: new Date().toISOString(),
    executionMode: 'websocket',
  };
}
async function loadConversationMessages(baseUrl, auth, conversationId, timeoutMs = 45_000) {
  const load = () => jsonRequest(
    `${baseUrl}/api/conversation/conversations/${encodeURIComponent(conversationId)}/messages`,
    { headers: { authorization: `Bearer ${auth.token}` } },
    timeoutMs,
  );
  try {
    return findArray(await load(), 'messages');
  } catch (error) {
    // 长批次中旧 token 可能在后续案例查询时被服务端拒绝；重新登录一次后只重试当前只读请求。
    if (!(error instanceof Error) || !error.message.startsWith('HTTP 401 ')) throw error;
    if (!isAutomaticReloginAllowed()) {
      throw new Error('测试登录态已失效（conversation API 返回 401）；为避免挤掉现有登录，会话 Runner 未自动重登。请更新私有 token 或执行一次 auth:setup。');
    }
    Object.assign(auth, await loginWithPassword(baseUrl));
    return findArray(await load(), 'messages');
  }
}
async function waitForPersistedAnswer(baseUrl, auth, conversationId, clientMessageId, beforeSnapshot, timeoutMs = PERSISTENCE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let emptyAssistantSeenAt = null;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    // 不把最后不足一秒的尾窗交给 HTTP 请求，否则会把“预算耗尽”伪装成 1 秒网络超时。
    if (remainingMs < 1_000) break;
    const messages = await loadConversationMessages(baseUrl, auth, conversationId, Math.min(45_000, remainingMs));
    const direct = [...messages].reverse().find((message) => message?.client_message_id === clientMessageId && isAssistant(message));
    if (direct) return direct;

    // Science42 当前仅稳定地把 client_message_id 写到用户消息；assistant 记录常不继承该字段。
    // 每个 worker 独占一个会话，因此以该用户消息为锚点，取下一条用户消息之前的最后一条 assistant，
    // 可避免回退到旧历史回答或并发请求的回答。
    const anchor = messages.findIndex((message) => message?.client_message_id === clientMessageId);
    if (anchor >= 0) {
      const following = messages.slice(anchor + 1);
      const nextUser = following.findIndex((message) => message?.role === 'user');
      const scoped = nextUser >= 0 ? following.slice(0, nextUser) : following;
      const answer = [...scoped].reverse().find(isAssistant);
      if (answer) return answer;

      // 服务偶发只插入空 assistant 占位而不再更新正文。先保留宽限期给正常流式落库，
      // 到期后明确报业务失败，不能让一个已确定无正文的案例占满整个持久化轮询窗口。
      const emptyAssistant = scoped.find((message) => message?.role === 'assistant'
        && typeof message.content === 'string' && !message.content.trim());
      if (emptyAssistant) {
        emptyAssistantSeenAt ||= Date.now();
        if (Date.now() - emptyAssistantSeenAt >= EMPTY_ASSISTANT_GRACE_MS) {
          throw new Error(`产品仅持久化空 assistant 回复，${Math.round(EMPTY_ASSISTANT_GRACE_MS / 1000)}s 内未写入正文`);
        }
      }
    }
    // 部分部署的历史接口会丢弃 client_message_id。worker 独占会话，因此只能接受
    // 发送前快照之外新增/更新的 assistant；绝不回退到任意历史最后一条回答。
    const answer = [...messages].reverse().find((message) => isAssistant(message) && !beforeSnapshot.has(messageFingerprint(message)));
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`请求已发送，但 ${Math.round(timeoutMs / 1000)}s 内未获得持久化 assistant 正文`);
}
function sendAndWait(wsUrl, payload) {
  let close;
  const completion = new Promise((resolve, reject) => {
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
    close = () => finish();
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
  return { completion, close: () => close?.() };
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
async function runOne({ job, conversationIds, baseUrl, auth }) {
  const started = Date.now();
  let sourceRef = null;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    // 关闭客户端连接不会取消产品端已接收的任务。重试必须换会话，避免迟到的
    // assistant 回复落在下一次用户消息之后而被错误关联。
    const conversationId = conversationIds[attempt - 1];
    if (!conversationId) {
      const error = new Error(`缺少第 ${attempt} 次重试的隔离会话，无法安全继续发送请求`);
      error.sourceRef = sourceRef;
      throw error;
    }
    const clientMessageId = `case-ws-${crypto.randomUUID()}`;
    sourceRef = buildSourceRef({ conversationId, clientMessageId, assistant: null, content: '' });
    const payload = {
      action: 'send_message', conversation_id: conversationId, client_message_id: clientMessageId,
      message: { content: job.prompt }, user_name: auth.userName, file_metadata: job.fileMetadata || [],
      taskid: `${conversationId}-${clientMessageId}`, team_type: job.teamType,
      ...(job.pdeImagePara ? { pde_image_para: job.pdeImagePara } : {}),
    };
    let socket = null;
    let requestDispatched = false;
    let socketObservationTimer = null;
    try {
      const beforeSnapshot = new Set((await loadConversationMessages(baseUrl, auth, conversationId)).map(messageFingerprint));
      const wsUrl = await resolveWsUrl(baseUrl);
      socket = sendAndWait(wsUrl, payload);
      requestDispatched = true;
      // 材料服务会持续输出但不总是发送 [end]。15 秒后只收口客户端 WS，
      // 仍按分类预算轮询同一会话的持久化正文；这避免长任务被重复提交。
      socketObservationTimer = setTimeout(() => socket?.close(), SOCKET_OBSERVATION_MS);
      const wsCompletion = socket.completion.catch((error) => ({ frameCount: 0, eventTypes: [`socket-error:${error.message}`] }));
      const assistant = await waitForPersistedAnswer(
        baseUrl, auth, conversationId, clientMessageId, beforeSnapshot, PERSISTENCE_TIMEOUT_MS,
      );
      clearTimeout(socketObservationTimer);
      const answer = String(assistant.content).trim();
      sourceRef = buildSourceRef({ conversationId, clientMessageId, assistant, content: answer });
      socket.close();
      socket = null;
      const ws = await wsCompletion;
      const checks = validateAnswer(job, answer);
      const failed = checks.filter((check) => !check.ok);
      return { status: failed.length ? 'FAILED' : 'PASSED', durationMs: Date.now() - started, checks, reason: failed.map((check) => check.detail).join('；') || '', ws, clientMessageId, sourceRef, attempts: attempt };
    } catch (error) {
      clearTimeout(socketObservationTimer);
      lastError = error instanceof Error ? error : new Error(String(error));
      socket?.close();
      // 失败路径也等待 completion 收口，避免上一次请求遗留超时计时器或未处理拒绝。
      await socket?.completion.catch(() => {});
      // 一旦 payload 已交给 WS，产品端可能仍在执行。重复发送只会制造并发任务和
      // 错误关联；持久化预算耗尽后应以一次可读失败收口，而不是继续换会话补发。
      if (requestDispatched) break;
      if (attempt < MAX_REQUEST_ATTEMPTS) {
        console.log(`[ws] #${job.position} 第 ${attempt}/${MAX_REQUEST_ATTEMPTS} 次未获得正文，已断开连接，准备重试：${lastError.message}`);
      }
    }
  }
  const error = new Error(`连续 ${MAX_REQUEST_ATTEMPTS} 次未获得正文：${lastError.message}`, { cause: lastError });
  error.sourceRef = sourceRef;
  throw error;
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
console.log('[ws-preflight] 登录测试账号…');
const auth = await authenticate(baseUrl);
console.log('[ws-preflight] 登录成功，获取可用会话…');
const conversations = await resolveConversationIds(baseUrl, auth.token, MAX_REQUEST_ATTEMPTS);
console.log(`[ws-preflight] 已获取 ${conversations.length} 个隔离重试会话`);
console.log(`[ws-batch] category=${CATEGORY} selected=${selected.length} mode=sequential transport=websocket`);

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
      const result = await runOne({ job: item, conversationIds: conversations, baseUrl, auth });
      results.push({ position: item.position, title: item.title, ...result });
      console.log(`[run ${slot}] #${item.position} ${item.title} → ${result.reason || result.status} (${Math.round(result.durationMs / 1000)}s)`);
      console.log(`[ws] #${item.position} frames=${result.ws.frameCount} types=${result.ws.eventTypes.join(',') || 'none'} request=${result.clientMessageId}`);
      console.log(`__CASE_WS_RESULT__${JSON.stringify({ position: item.position, executionMode: 'websocket', requestId: result.clientMessageId, frameCount: result.ws.frameCount, eventTypes: result.ws.eventTypes, checks: result.checks, sourceRef: result.sourceRef })}`);
    } catch (error) {
      const result = { position: item.position, title: item.title, status: 'FAILED', reason: error instanceof Error ? error.message : String(error), durationMs: Date.now() - runStarted };
      results.push(result); console.log(`[run ${slot}] #${item.position} ${item.title} → ${result.reason} (${Math.round(result.durationMs / 1000)}s)`);
      if (error?.sourceRef) console.log(`__CASE_WS_RESULT__${JSON.stringify({ position: item.position, executionMode: 'websocket', sourceRef: error.sourceRef })}`);
    }
    if (cursor < selected.length) {
      console.log(`[ws] #${item.position} 已结算，等待 ${INTER_CASE_DELAY_MS / 1000}s 后执行下一题…`);
      await new Promise((resolve) => setTimeout(resolve, INTER_CASE_DELAY_MS));
    }
  }
}
await Promise.all(Array.from({ length: Math.min(PARALLEL, selected.length) }, (_, index) => worker(index + 1)));
const ordered = results.sort((a, b) => a.position - b.position);
const failed = ordered.filter((result) => result.status !== 'PASSED');
console.log(`通过 ${ordered.length - failed.length}/${ordered.length}`);
process.exit(failed.length ? 1 : 0);

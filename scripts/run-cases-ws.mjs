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
const REQUESTED_CONVERSATION_ID = opt('conversation-id', '').trim() || null;
const NEW_CONVERSATION = args.includes('--new-conversation') || !REQUESTED_CONVERSATION_ID;
const PARALLEL = 1;
const MAX_REQUEST_ATTEMPTS = 3;
const INTER_CASE_DELAY_MS = 10_000;
const ANSWER_TIMEOUT_MS = Number(opt('timeout', CATEGORY === 'data' ? 660_000 : 300_000));
const PERSISTENCE_TIMEOUT_MS = Number(opt('persistence-timeout', CATEGORY === 'data' ? 660_000 : CATEGORY === 'material' ? 390_000 : 60_000));
// 无正文时继续占满 390/660 秒会阻塞串行轮询；首段正文缺席时换专用会话重试。
const FIRST_ASSISTANT_BODY_TIMEOUT_MS = Number(opt('first-assistant-body-timeout', 15_000));
const EMPTY_ASSISTANT_GRACE_MS = Number(opt('empty-assistant-grace', 90_000));
const POLL_MS = 2_000;
const DRY = args.includes('--dry');

function usage() {
  console.log('Usage: npm run run:cases-ws -- --category=physics|data|material --indices=1,2 [--new-conversation|--conversation-id=<id>] [--dry]');
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

/**
 * 数据建模的规划、建模和产物有时会被拆成多条 assistant 记录持久化。
 * 验收应观察本次请求后的完整片段集合，但 sourceRef 仍锚定最后一条真实消息，
 * 以便预览时可准确回查产品端原文。
 */
function combinedAssistantContent(messages) {
  return messages
    .filter(isAssistant)
    .map((message) => String(message.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function waitForPersistedAnswer(baseUrl, auth, conversationId, clientMessageId, beforeSnapshot, timeoutMs = PERSISTENCE_TIMEOUT_MS, isComplete = () => true) {
  const deadline = Date.now() + timeoutMs;
  const firstAssistantBodyDeadline = Date.now() + Math.min(FIRST_ASSISTANT_BODY_TIMEOUT_MS, timeoutMs);
  let emptyAssistantSeenAt = null;
  let incompleteAssistant = null;
  let incompleteVerificationContent = '';
  let assistantBodySeen = false;
  const firstBodyTimeout = () => {
    const error = new Error(`产品在 ${Math.round(FIRST_ASSISTANT_BODY_TIMEOUT_MS / 1000)}s 内未写入非空 assistant 正文，已断开并换新会话重试`);
    error.phase = 'first_assistant_body_timeout';
    error.firstAssistantBodyTimeoutMs = FIRST_ASSISTANT_BODY_TIMEOUT_MS;
    return error;
  };
  const accept = (candidate, verificationContent = String(candidate?.content || '').trim()) => {
    if (!candidate) return null;
    assistantBodySeen = true;
    if (isComplete(verificationContent)) return { assistant: candidate, verificationContent };
    incompleteAssistant = candidate;
    incompleteVerificationContent = verificationContent;
    return null;
  };
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    // 不把最后不足一秒的尾窗交给 HTTP 请求，否则会把“预算耗尽”伪装成 1 秒网络超时。
    if (remainingMs < 1_000) break;
    // 首段正文窗口也约束本次读取，不能让单个卡住的 HTTP 请求越过 15 秒阈值。
    const firstBodyRemainingMs = firstAssistantBodyDeadline - Date.now();
    const requestBudgetMs = assistantBodySeen
      ? remainingMs
      : Math.min(remainingMs, Math.max(1_000, firstBodyRemainingMs));
    let messages;
    try {
      messages = await loadConversationMessages(baseUrl, auth, conversationId, Math.min(45_000, requestBudgetMs));
    } catch (error) {
      if (!assistantBodySeen && Date.now() >= firstAssistantBodyDeadline && /^HTTP 请求超时/.test(String(error?.message || ''))) {
        throw firstBodyTimeout();
      }
      throw error;
    }
    const direct = [...messages].reverse().find((message) => message?.client_message_id === clientMessageId && isAssistant(message));
    const directAccepted = accept(direct);
    if (directAccepted) return directAccepted;

    // Science42 当前仅稳定地把 client_message_id 写到用户消息；assistant 记录常不继承该字段。
    // 每个 worker 独占一个会话，因此以该用户消息为锚点，取下一条用户消息之前的最后一条 assistant，
    // 可避免回退到旧历史回答或并发请求的回答。
    const anchor = messages.findIndex((message) => message?.client_message_id === clientMessageId);
    if (anchor >= 0) {
      const following = messages.slice(anchor + 1);
      const nextUser = following.findIndex((message) => message?.role === 'user');
      const scoped = nextUser >= 0 ? following.slice(0, nextUser) : following;
      const answer = [...scoped].reverse().find(isAssistant);
      const accepted = accept(answer, combinedAssistantContent(scoped));
      if (accepted) return accepted;

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
    const newAssistants = messages.filter((message) => isAssistant(message) && !beforeSnapshot.has(messageFingerprint(message)));
    const answer = newAssistants.at(-1) || null;
    const accepted = accept(answer, combinedAssistantContent(newAssistants));
    if (accepted) return accepted;
    if (!assistantBodySeen && Date.now() >= firstAssistantBodyDeadline) {
      throw firstBodyTimeout();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error(incompleteAssistant
    ? `已持久化 assistant 回复，但 ${Math.round(timeoutMs / 1000)}s 内未达到完整验收条件`
    : `请求已发送，但 ${Math.round(timeoutMs / 1000)}s 内未获得持久化 assistant 正文`);
  error.assistant = incompleteAssistant;
  error.verificationContent = incompleteVerificationContent;
  throw error;
}
function sendAndWait(wsUrl, payload, initialConversationId = null) {
  let close;
  let settleConversation;
  let rejectConversation;
  let conversationSettled = Boolean(initialConversationId);
  const conversationReady = new Promise((resolve, reject) => {
    settleConversation = resolve;
    rejectConversation = reject;
    if (initialConversationId) resolve(initialConversationId);
  });
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
      if (error) {
        if (!conversationSettled) rejectConversation(error);
        reject(error);
      } else {
        if (!conversationSettled) rejectConversation(new Error('WebSocket 已结束但产品未返回 conversation_created'));
        resolve({ frameCount, eventTypes: [...eventTypes] });
      }
    };
    close = () => finish();
    // Node 22 的 WebSocket 是 EventTarget；不用浏览器属性回调，避免 open 事件未挂上的兼容性问题。
    socket.addEventListener('open', () => { opened = true; socket.send(JSON.stringify(payload)); });
    socket.addEventListener('message', (event) => {
      frameCount += 1;
      const raw = String(event.data || '');
      try {
        const parsed = JSON.parse(raw);
        eventTypes.add(parsed?.type ? String(parsed.type) : 'json');
        if (!conversationSettled && parsed?.type === 'conversation_created') {
          const conversationId = findString(parsed, ['conversation_id', 'conversationId', 'id']);
          if (conversationId) {
            conversationSettled = true;
            settleConversation(conversationId);
          }
        }
      } catch { eventTypes.add('text'); }
      if (raw.trim() === '[end]' || /【.*(?:已结束|已完成):.*】/.test(raw)) finish();
    });
    socket.addEventListener('error', () => finish(new Error('WebSocket 连接或传输失败')));
    socket.addEventListener('close', () => { if (!finished && frameCount > 0) finish(); });
  });
  return { completion, conversationReady, close: () => close?.() };
}

const DATA_FLOW_PATTERN = /CAD\s*组装与建模任务|构思装配结构规划|编写底层代码|生成几何实体|三维(?:CAD)?(?:网格|模型)|网格(?:生成|划分)|可视化/i;
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
    // 数据建模团队的分段文案会随任务模板和模型版本变化；只确认已进入 CAD/网格流程，
    // 不再要求四句固定文案在同一条消息中出现。最终通过仍必须有 STL 产物。
    checks.push({ key: 'cad_flow', ok: DATA_FLOW_PATTERN.test(content), detail: 'CAD/网格流程已启动' });
    checks.push({ key: 'stl', ok: /\.stl(?:[?#]|$)|<<<STL_VIEWER:|STL 模型|>STL<|STL_VIEWER/i.test(content), detail: 'STL 产物' });
  } else {
    const retrieval = /中文检索项/.test(content) && /论文检索进度|检索概览|检索结果重排|文献检索/.test(content) && /综合回答/.test(content);
    const analysis = /材料名称核对|已入库性质|本轮建议|核心材料需求|候选材料|需求与瓶颈的关联/.test(content) && /追问推荐\s*[→>]?/.test(content);
    checks.push({ key: 'material_profile', ok: retrieval || analysis, detail: retrieval ? '检索综合型' : analysis ? '文本分析型' : '未识别材料 Profile' });
  }
  return checks;
}
async function runOne({ job, baseUrl, auth }) {
  const started = Date.now();
  let sourceRef = null;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    // 关闭客户端连接不会取消产品端已接收的任务。重试必须换会话，避免迟到的
    // assistant 回复落在下一次用户消息之后而被错误关联。
    let conversationId = attempt === 1 && !NEW_CONVERSATION ? REQUESTED_CONVERSATION_ID : null;
    const clientMessageId = `case-ws-${crypto.randomUUID()}`;
    sourceRef = buildSourceRef({ conversationId, clientMessageId, assistant: null, content: '' });
    const payload = {
      action: 'send_message', client_message_id: clientMessageId,
      message: { content: job.prompt }, user_name: auth.userName, file_metadata: job.fileMetadata || [],
      taskid: `${conversationId || 'new'}-${clientMessageId}`, team_type: job.teamType,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(job.pdeImagePara ? { pde_image_para: job.pdeImagePara } : {}),
    };
    let socket = null;
    try {
      const beforeSnapshot = conversationId
        ? new Set((await loadConversationMessages(baseUrl, auth, conversationId)).map(messageFingerprint))
        : new Set();
      const wsUrl = await resolveWsUrl(baseUrl);
      socket = sendAndWait(wsUrl, payload, conversationId);
      conversationId = await socket.conversationReady;
      sourceRef = buildSourceRef({ conversationId, clientMessageId, assistant: null, content: '' });
      // 不能主动关闭 WS：物理等团队会将客户端断开视为取消生成。业务完成以
      // 持久化回答满足该案例完整验收项为准，而不是第一段非空 assistant 内容。
      const wsCompletion = socket.completion.catch((error) => ({ frameCount: 0, eventTypes: [`socket-error:${error.message}`] }));
      const answerResult = await waitForPersistedAnswer(
        baseUrl, auth, conversationId, clientMessageId, beforeSnapshot, PERSISTENCE_TIMEOUT_MS,
        (content) => validateAnswer(job, content).every((check) => check.ok),
      );
      const { assistant, verificationContent } = answerResult;
      const answer = String(assistant.content).trim();
      sourceRef = buildSourceRef({ conversationId, clientMessageId, assistant, content: answer });
      socket.close();
      socket = null;
      const ws = await wsCompletion;
      const checks = validateAnswer(job, verificationContent);
      const failed = checks.filter((check) => !check.ok);
      return { status: failed.length ? 'FAILED' : 'PASSED', durationMs: Date.now() - started, checks, reason: failed.map((check) => check.detail).join('；') || '', ws, clientMessageId, sourceRef, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const observedContent = String(lastError.verificationContent || lastError.assistant?.content || '').trim();
      if (lastError.assistant) {
        sourceRef = buildSourceRef({ conversationId, clientMessageId, assistant: lastError.assistant, content: lastError.assistant.content });
        const checks = validateAnswer(job, observedContent);
        lastError.checks = checks;
        lastError.receivedContentLength = observedContent.length;
        const missing = checks.filter((check) => !check.ok).map((check) => check.detail);
        lastError.message = `已收到 ${observedContent.length} 字 assistant 回复，但本次案例尚未完成：${missing.join('；') || '未达到完整验收条件'}`;
      }
      lastError.clientMessageId = clientMessageId;
      socket?.close();
      // 失败路径也等待 completion 收口，避免上一次请求遗留超时计时器或未处理拒绝。
      lastError.ws = await socket?.completion.catch((socketError) => ({ frameCount: 0, eventTypes: [`socket-error:${socketError.message}`] }));
      if (attempt < MAX_REQUEST_ATTEMPTS) {
        console.log(`[ws] #${job.position} 第 ${attempt}/${MAX_REQUEST_ATTEMPTS} 次未获得正文，已断开连接，准备重试：${lastError.message}`);
      }
    }
  }
  const error = new Error(lastError?.message || '案例请求未能完成', { cause: lastError });
  error.sourceRef = sourceRef;
  error.checks = lastError?.checks || null;
  error.clientMessageId = lastError?.clientMessageId || null;
  error.ws = lastError?.ws || null;
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
console.log(`[ws-preflight] 登录成功，将${NEW_CONVERSATION ? '创建专用会话' : '使用指定会话'}…`);
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
      const result = await runOne({ job: item, baseUrl, auth });
      results.push({ position: item.position, title: item.title, ...result });
      console.log(`[run ${slot}] #${item.position} ${item.title} → ${result.reason || result.status} (${Math.round(result.durationMs / 1000)}s)`);
      console.log(`[ws] #${item.position} frames=${result.ws.frameCount} types=${result.ws.eventTypes.join(',') || 'none'} request=${result.clientMessageId}`);
      console.log(`__CASE_WS_RESULT__${JSON.stringify({ position: item.position, executionMode: 'websocket', requestId: result.clientMessageId, frameCount: result.ws.frameCount, eventTypes: result.ws.eventTypes, checks: result.checks, sourceRef: result.sourceRef })}`);
    } catch (error) {
      const result = { position: item.position, title: item.title, status: 'FAILED', reason: error instanceof Error ? error.message : String(error), durationMs: Date.now() - runStarted };
      results.push(result); console.log(`[run ${slot}] #${item.position} ${item.title} → ${result.reason} (${Math.round(result.durationMs / 1000)}s)`);
      if (error?.sourceRef) console.log(`__CASE_WS_RESULT__${JSON.stringify({
        position: item.position,
        executionMode: 'websocket',
        requestId: error.clientMessageId || null,
        frameCount: Number.isInteger(error.ws?.frameCount) ? error.ws.frameCount : null,
        eventTypes: Array.isArray(error.ws?.eventTypes) ? error.ws.eventTypes : null,
        checks: Array.isArray(error.checks) ? error.checks : null,
        sourceRef: error.sourceRef,
      })}`);
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

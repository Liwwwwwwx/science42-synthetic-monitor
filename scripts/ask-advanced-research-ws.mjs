#!/usr/bin/env node
/**
 * 通过 XIMUFORSCIENCE WebSocket 提问 AdvancedResearch，避免启动 Chromium。
 * 最后一行始终输出 __RESEARCH_RESULT__{json}，供 Science Admin runner 入库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { getResearchQuestion } from '../shared/config/research-questions.mjs';
import { getTargetUrl } from '../shared/config/project.mjs';
import { isAutomaticReloginAllowed, loadReusableWsAuth } from '../shared/auth/reusable-ws-auth.mjs';

const ANSWER_TIMEOUT_MS = Number(process.env.WS_ANSWER_TIMEOUT_MS || 15 * 60 * 1000);
const PERSISTENCE_TIMEOUT_MS = Number(process.env.WS_PERSISTENCE_TIMEOUT_MS || 60_000);
const POLL_MS = 2_000;

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function emitResult(payload) {
  console.log(`__RESEARCH_RESULT__${JSON.stringify(payload)}`);
}

function logProgress(message) {
  console.log(`[progress] ${message}`);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function findString(value, keys) {
  const object = asObject(value);
  if (!object) return '';
  for (const key of keys) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  for (const child of Object.values(object)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return '';
}

function findArray(value, key) {
  const object = asObject(value);
  if (!object) return [];
  if (Array.isArray(object[key])) return object[key];
  for (const child of Object.values(object)) {
    const found = findArray(child, key);
    if (found.length) return found;
  }
  return [];
}

async function jsonRequest(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status} ${new URL(url).pathname}`);
  return data;
}

async function loadJob() {
  const jobPath = arg('job');
  if (jobPath) {
    const job = JSON.parse(await fs.readFile(path.resolve(jobPath), 'utf8'));
    if (!job.questionId || !job.prompt) throw new Error('job 缺少 questionId/prompt');
    return job;
  }
  const questionId = arg('question-id') || process.env.RESEARCH_QUESTION_ID;
  const question = questionId && getResearchQuestion(questionId);
  if (!question) throw new Error('需要有效的 --question-id 或 --job');
  return { ...question, questionId: question.id };
}

async function loginWithPassword(baseUrl) {
  if (!process.env.SCIENCE42_USER || !process.env.SCIENCE42_PASSWORD) {
    throw new Error('缺少 SCIENCE42_USER/SCIENCE42_PASSWORD');
  }
  const login = await jsonRequest(`${baseUrl}/api/user/account_login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

async function resolveConversation(baseUrl, token) {
  const data = await jsonRequest(`${baseUrl}/api/conversation/conversations?page=1&limit=20`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const conversations = findArray(data, 'conversations');
  const conversation = conversations.find((item) => findString(item, ['external_id', 'externalId', 'conversation_id', 'conversationId', 'id']));
  const conversationId = findString(conversation, ['external_id', 'externalId', 'conversation_id', 'conversationId', 'id']);
  if (!conversationId) throw new Error('测试账号没有可用的 conversation_id');
  return conversationId;
}

async function resolveWsUrl(baseUrl) {
  const data = await jsonRequest(`${baseUrl}/api/getWsUrl`);
  if (typeof data.message !== 'string' || !/^wss?:\/\//.test(data.message)) throw new Error('本地前端未提供有效 WS_URL');
  return data.message;
}

function messageContent(message) {
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

function isAssistant(message) {
  return message?.role === 'assistant' && messageContent(message);
}

async function waitForPersistedAnswer(baseUrl, token, conversationId, clientMessageId) {
  const deadline = Date.now() + PERSISTENCE_TIMEOUT_MS;
  let fallback = '';
  while (Date.now() < deadline) {
    const data = await jsonRequest(`${baseUrl}/api/conversation/conversations/${encodeURIComponent(conversationId)}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const messages = findArray(data, 'messages');
    const correlated = messages.filter((message) => message?.client_message_id === clientMessageId);
    const answer = [...correlated].reverse().find(isAssistant) || [...messages].reverse().find(isAssistant);
    if (answer) {
      const content = messageContent(answer);
      if (content.length > fallback.length) fallback = content;
      if (correlated.some((message) => isAssistant(message))) return fallback;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (fallback) return fallback;
  throw new Error('回答未在会话消息记录中持久化');
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
    let completed = false;
    const finish = (error = null) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      try { socket.close(1000, 'answer completed'); } catch { /* ignore */ }
      if (error) {
        if (!conversationSettled) rejectConversation(error);
        reject(error);
      } else {
        if (!conversationSettled) rejectConversation(new Error('WebSocket 已结束但产品未返回 conversation_created'));
        resolve({ frameCount, eventTypes: [...eventTypes] });
      }
    };
    const timer = setTimeout(() => finish(new Error(`WebSocket 回答超时（${Math.round(ANSWER_TIMEOUT_MS / 1000)}s）`)), ANSWER_TIMEOUT_MS);
    close = () => finish();
    socket.onopen = () => {
      logProgress('ws connected; sending question');
      socket.send(JSON.stringify(payload));
    };
    socket.onmessage = (event) => {
      frameCount += 1;
      const raw = String(event.data || '');
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.type) eventTypes.add(String(parsed.type));
        else eventTypes.add('json');
        if (!conversationSettled && parsed?.type === 'conversation_created') {
          const conversationId = findString(parsed, ['conversation_id', 'conversationId', 'id']);
          if (conversationId) {
            conversationSettled = true;
            settleConversation(conversationId);
          }
        }
      } catch {
        eventTypes.add('text');
      }
      // 与产品端 ChatStore 的完成协议保持一致。
      if (raw.trim() === '[end]' || /【.*(?:已结束|已完成):.*】/.test(raw)) finish();
    };
    socket.onerror = () => {
      finish(new Error('WebSocket 连接或传输失败'));
    };
    socket.onclose = () => {
      // 部分后端以正常 close 表示流式回答结束。
      if (!completed && frameCount > 0) finish();
    };
  });
  return { completion, conversationReady, close: () => close?.() };
}

let currentJob = null;
let startedAt = 0;

async function main() {
  const job = await loadJob();
  currentJob = job;
  const baseUrl = getTargetUrl();
  const started = Date.now();
  startedAt = started;
  logProgress(`question=${job.questionId} transport=websocket`);
  const { token, userName } = await authenticate(baseUrl);
  const requestedConversationId = arg('conversation-id');
  let conversationId = requestedConversationId || null;
  if (!conversationId && !process.argv.includes('--new-conversation')) {
    // 兼容旧命令：未显式指定时才继续使用旧的历史会话选择逻辑。
    conversationId = await resolveConversation(baseUrl, token);
  }
  const wsUrl = await resolveWsUrl(baseUrl);
  const clientMessageId = `research-dataset-${crypto.randomUUID()}`;
  const payload = {
    action: 'send_message',
    client_message_id: clientMessageId,
    message: { content: job.prompt },
    user_name: userName,
    file_metadata: [],
    taskid: `${conversationId || 'new'}-${clientMessageId}`,
    team_type: 'deepresearch',
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
  const socket = sendAndWait(wsUrl, payload, conversationId);
  conversationId = await socket.conversationReady;
  const wsResult = await socket.completion;
  logProgress(`ws frames=${wsResult.frameCount} types=${wsResult.eventTypes.join(',') || 'none'}; checking persistence`);
  const answer = await waitForPersistedAnswer(baseUrl, token, conversationId, clientMessageId);
  emitResult({
    ok: true,
    questionId: job.questionId,
    category: job.category || null,
    topic: job.topic || null,
    domain: job.domain || null,
    variant: job.variant ?? null,
    userContent: job.prompt,
    assistantContent: answer,
    answerChars: answer.length,
    conversationId,
    clientMessageId,
    durationMs: Date.now() - started,
    collectedAt: new Date().toISOString(),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  emitResult({ ok: false, questionId: currentJob?.questionId || arg('question-id') || 'unknown', userContent: currentJob?.prompt || '', assistantContent: '', answerChars: 0, durationMs: startedAt ? Date.now() - startedAt : 0, error: message, collectedAt: new Date().toISOString() });
  process.exitCode = 1;
});

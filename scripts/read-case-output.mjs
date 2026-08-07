#!/usr/bin/env node
/**
 * 按已持久化的案例 sourceRef 从 Science42 产品端读取当前 assistant 正文。
 * 仅输出单行 JSON，供 Admin 后端短生命周期调用；正文不会写本地文件或日志。
 */
import crypto from 'node:crypto';
import process from 'node:process';
import { getTargetUrl } from '../shared/config/project.mjs';
import { loadReusableWsAuth } from '../shared/auth/reusable-ws-auth.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function findString(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  for (const child of Object.values(value)) { const found = findString(child, keys); if (found) return found; }
  return '';
}
function findArray(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  if (Array.isArray(value[key])) return value[key];
  for (const child of Object.values(value)) { const found = findArray(child, key); if (found.length) return found; }
  return [];
}
function isAssistant(message) {
  if (message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()) return false;
  try {
    const parsed = JSON.parse(message.content);
    return !(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.type === 'string');
  } catch { return true; }
}
function messageId(message) { return findString(message, ['id', 'message_id', 'messageId', 'external_id', 'externalId']); }
function result(payload) { process.stdout.write(`__CASE_OUTPUT__${JSON.stringify(payload)}\n`); }
function unavailable(reasonCode, reason) { result({ available: false, reasonCode, reason }); process.exit(0); }
function inputRef() {
  const raw = process.argv.find((arg) => arg.startsWith('--source-ref='))?.slice('--source-ref='.length);
  if (!raw) throw new Error('缺少 --source-ref');
  const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || typeof value.conversationId !== 'string' || !value.conversationId) throw new Error('sourceRef 缺少 conversationId');
  return value;
}
async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  return data;
}
function selectAssistant(messages, sourceRef) {
  if (sourceRef.assistantMessageId) {
    const exact = messages.find((message) => messageId(message) === sourceRef.assistantMessageId && isAssistant(message));
    if (exact) return exact;
  }
  if (sourceRef.clientMessageId) {
    const anchor = messages.findIndex((message) => message?.client_message_id === sourceRef.clientMessageId);
    if (anchor >= 0) {
      const following = messages.slice(anchor + 1);
      const nextUser = following.findIndex((message) => message?.role === 'user');
      return [...(nextUser >= 0 ? following.slice(0, nextUser) : following)].reverse().find(isAssistant) || null;
    }
  }
  if (typeof sourceRef.contentSha256 === 'string' && sourceRef.contentSha256) {
    return messages.find((message) => isAssistant(message)
      && crypto.createHash('sha256').update(String(message.content).trim()).digest('hex') === sourceRef.contentSha256) || null;
  }
  return null;
}

try {
  const sourceRef = inputRef();
  const baseUrl = getTargetUrl();
  const auth = await loadReusableWsAuth(baseUrl);
  if (!auth) unavailable('AUTH_UNAVAILABLE', '监控登录态不可用；请更新私有 token 或重新执行 auth:setup。');
  const data = await requestJson(`${baseUrl}/api/conversation/conversations/${encodeURIComponent(sourceRef.conversationId)}/messages`, {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  const assistant = selectAssistant(findArray(data, 'messages'), sourceRef);
  if (!assistant) unavailable('MESSAGE_NOT_FOUND', '产品端未找到与本次案例关联的 assistant 回复；消息可能已删除或会话已变化。');
  const fullContent = String(assistant.content).trim();
  const bytes = Buffer.byteLength(fullContent, 'utf8');
  const content = bytes > MAX_OUTPUT_BYTES ? Buffer.from(fullContent, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8') : fullContent;
  const contentSha256 = crypto.createHash('sha256').update(fullContent).digest('hex');
  result({
    available: true,
    content,
    truncated: bytes > MAX_OUTPUT_BYTES,
    contentLength: fullContent.length,
    contentSha256,
    contentUnchanged: !sourceRef.contentSha256 || sourceRef.contentSha256 === contentSha256,
    assistantMessageId: messageId(assistant) || null,
  });
} catch (error) {
  if (error?.status === 401) unavailable('AUTH_EXPIRED', '监控登录态已失效（产品 API 返回 401）；请更新私有 token 或重新执行 auth:setup。');
  if (error?.status === 404) unavailable('MESSAGE_NOT_FOUND', '产品端未找到该会话或关联回答；消息可能已删除。');
  unavailable('PRODUCT_READ_FAILED', error instanceof Error ? `读取产品原始回答失败：${error.message}` : '读取产品原始回答失败。');
}

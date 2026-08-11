const SAFE_CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

function safeCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && SAFE_CODE_RE.test(normalized) ? normalized : null;
}

function eventErrorCode(event) {
  const candidates = [event?.error?.cause?.code, event?.error?.code, event?.code];
  for (const candidate of candidates) {
    const code = safeCode(candidate);
    if (code) return code;
  }
  const message = typeof event?.message === 'string' ? event.message : '';
  const status = /\b(?:status|response)[^0-9]{0,12}(\d{3})\b/i.exec(message)?.[1];
  return status ? `HTTP_${status}` : null;
}

function stageOf(state) {
  if (!state.opened) return 'connecting';
  return state.sent ? 'request_sent' : 'opened';
}

function stageLabel(stage) {
  if (stage === 'connecting') return '建连阶段';
  if (stage === 'opened') return '连接已建立但消息发送前';
  return '消息已发送后';
}

function attachDiagnostic(message, diagnostic) {
  const error = new Error(message);
  error.wsDiagnostic = diagnostic;
  return error;
}

export function createWebSocketError(event, state) {
  const stage = stageOf(state);
  const code = eventErrorCode(event);
  const diagnostic = {
    stage,
    opened: Boolean(state.opened),
    sent: Boolean(state.sent),
    frameCount: Number.isInteger(state.frameCount) ? state.frameCount : 0,
    eventTypes: Array.isArray(state.eventTypes) ? state.eventTypes : [],
    code,
    closeCode: null,
  };
  return attachDiagnostic(`WebSocket ${stageLabel(stage)}连接或传输失败${code ? `（${code}）` : ''}`, diagnostic);
}

export function createWebSocketCloseError(event, state) {
  const stage = stageOf(state);
  const closeCode = Number.isInteger(event?.code) ? event.code : null;
  const diagnostic = {
    stage,
    opened: Boolean(state.opened),
    sent: Boolean(state.sent),
    frameCount: Number.isInteger(state.frameCount) ? state.frameCount : 0,
    eventTypes: Array.isArray(state.eventTypes) ? state.eventTypes : [],
    code: null,
    closeCode,
  };
  return attachDiagnostic(`WebSocket ${stageLabel(stage)}被关闭${closeCode != null ? `（close=${closeCode}）` : ''}`, diagnostic);
}

export function retryBackoffMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  return Math.min(attempt * 5_000, 10_000);
}

export function formatAttemptDiagnostic(attempt, error, durationMs, retryDelayMs = 0) {
  const diagnostic = error?.wsDiagnostic || {};
  const parts = [
    `第 ${attempt} 次`,
    `阶段 ${diagnostic.stage || 'unknown'}`,
    `open=${diagnostic.opened ? 'yes' : 'no'}`,
    `sent=${diagnostic.sent ? 'yes' : 'no'}`,
    `frames=${Number.isInteger(diagnostic.frameCount) ? diagnostic.frameCount : 0}`,
  ];
  if (diagnostic.code) parts.push(`code=${diagnostic.code}`);
  if (diagnostic.closeCode != null) parts.push(`close=${diagnostic.closeCode}`);
  if (Number.isFinite(durationMs)) parts.push(`耗时 ${Math.max(0, Math.round(durationMs / 1000))}s`);
  if (retryDelayMs > 0) parts.push(`${retryDelayMs / 1000}s 后重试`);
  return parts.join(' · ');
}

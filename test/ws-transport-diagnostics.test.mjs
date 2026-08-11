import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebSocketCloseError,
  createWebSocketError,
  formatAttemptDiagnostic,
  retryBackoffMs,
} from '../shared/ws/transport-diagnostics.mjs';

test('WebSocket error preserves safe phase and network code without raw URL', () => {
  const error = createWebSocketError({
    message: 'connect wss://example.invalid/start?token=secret failed',
    error: { cause: { code: 'ECONNREFUSED' } },
  }, { opened: false, sent: false, frameCount: 0, eventTypes: [] });
  assert.equal(error.message, 'WebSocket 建连阶段连接或传输失败（ECONNREFUSED）');
  assert.equal(error.message.includes('secret'), false);
  assert.deepEqual(error.wsDiagnostic, {
    stage: 'connecting', opened: false, sent: false, frameCount: 0, eventTypes: [], code: 'ECONNREFUSED', closeCode: null,
  });
});

test('zero-frame close is reported immediately with close code', () => {
  const error = createWebSocketCloseError({ code: 1006, reason: 'ignored' }, {
    opened: true, sent: true, frameCount: 0, eventTypes: [],
  });
  assert.equal(error.message, 'WebSocket 消息已发送后被关闭（close=1006）');
  assert.equal(error.wsDiagnostic.closeCode, 1006);
});

test('retry backoff is bounded and diagnostic is readable', () => {
  assert.equal(retryBackoffMs(1), 5_000);
  assert.equal(retryBackoffMs(2), 10_000);
  assert.equal(retryBackoffMs(3), 10_000);
  const error = createWebSocketError({ error: { code: 'UND_ERR_SOCKET' } }, {
    opened: true, sent: true, frameCount: 2, eventTypes: ['team_status'],
  });
  assert.equal(
    formatAttemptDiagnostic(2, error, 2_400, 10_000),
    '第 2 次 · 阶段 request_sent · open=yes · sent=yes · frames=2 · code=UND_ERR_SOCKET · 耗时 2s · 10s 后重试',
  );
});

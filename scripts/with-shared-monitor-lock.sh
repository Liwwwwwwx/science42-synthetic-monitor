#!/bin/sh
# 所有使用同一 Science 测试账号的 Runner 统一串行，避免登录态互踢或消息归属串线。
# 线上 systemd 与 Admin 后端只要都经 npm script 启动，就会自然共享这把锁。
set -eu

lock_file="${SYNTHETIC_SHARED_LOCK_FILE:-/tmp/science42-synthetic-monitor.lock}"
wait_seconds="${SYNTHETIC_SHARED_LOCK_WAIT_SECONDS:-1800}"

if ! command -v flock >/dev/null 2>&1; then
  echo "[shared-lock] flock unavailable; running without cross-process lock" >&2
  exec "$@"
fi

exec flock -w "$wait_seconds" "$lock_file" "$@"

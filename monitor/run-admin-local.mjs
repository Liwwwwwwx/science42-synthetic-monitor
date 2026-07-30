import { execFileSync, spawnSync } from 'node:child_process';

const keychainService = process.env.SYNTHETIC_MONITOR_KEYCHAIN_SERVICE || 'science42-synthetic-monitor-admin-runner';
let enrollment;

try {
  enrollment = JSON.parse(execFileSync('security', [
    'find-generic-password',
    '-s', keychainService,
    '-a', 'config',
    '-w',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {
  console.error('未找到本机 Runner 配置。请先在 Science Admin 创建或轮换 Runner Token。');
  process.exitCode = 1;
}

if (!process.exitCode) {
  const result = spawnSync(process.execPath, ['monitor/core-flow-monitor.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SCIENCE42_MONITOR_URL: process.env.SCIENCE42_MONITOR_URL || enrollment.targetUrl,
      SYNTHETIC_MONITOR_REPORT_URL: enrollment.reportUrl,
      SYNTHETIC_MONITOR_RUNNER_ID: enrollment.runnerId,
      SYNTHETIC_MONITOR_RUNNER_TOKEN: enrollment.token,
    },
  });
  process.exitCode = result.status || 0;
}

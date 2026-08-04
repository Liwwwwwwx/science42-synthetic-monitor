import fs from 'node:fs/promises';
import path from 'node:path';
import { finishSuiteReport } from '../../shared/report/index.mjs';

const startedAt = new Date();
const baseUrl = (process.env.SCIENCE42_API_URL || 'https://www.science42.tech').replace(/\/$/, '');
const timeoutMs = Number(process.env.API_TIMEOUT_MS || 10_000);
const token = process.env.SCIENCE42_API_TOKEN || '';
const cookie = process.env.SCIENCE42_COOKIE || '';
const artifactRoot = process.env.API_ARTIFACT_DIR || 'results/runs/team_api';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const runDir = path.join(artifactRoot, runId);
await fs.mkdir(runDir, { recursive: true });

// 仅使用只读接口，不创建、修改、加入、踢出或删除团队数据。
const checks = [
  { id: 'group_plans', method: 'GET', path: '/api/v1/group/group_plans' },
  { id: 'personal_groups', method: 'GET', path: '/api/v1/group/personal_group_name_list' },
  { id: 'user_groups', method: 'GET', path: '/api/v1/group/user_group_list' },
  { id: 'user_apply', method: 'GET', path: '/api/v1/group/check_user_apply' },
  { id: 'favorite_conversations', method: 'GET', path: '/api/v1/groupconv/groups/favorites/conversations?limit=10&offset=0' },
  { id: 'favorite_messages', method: 'GET', path: '/api/v1/groupconv/groups/favorites/messages?limit=10&offset=0' },
];

function headers() {
  const value = { accept: 'application/json' };
  if (token) value.authorization = `Bearer ${token}`;
  if (cookie) value.cookie = cookie;
  return value;
}

async function checkOne(item) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  let body = '';
  let error = null;
  try {
    const response = await fetch(`${baseUrl}${item.path}`, { method: item.method, headers: headers(), signal: controller.signal });
    status = response.status;
    body = (await response.text()).slice(0, 2000);
  } catch (e) {
    error = e?.name === 'AbortError' ? `timeout>${timeoutMs}ms` : String(e?.message || e);
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Date.now() - started;
  // 401/403 with auth expected still means service is up; only hard-fail 5xx/timeout/network
  const passed = status !== null && status < 500;
  return { ...item, url: `${baseUrl}${item.path}`, status, elapsedMs, passed, error, body };
}

const results = [];
for (const item of checks) results.push(await checkOne(item));
const summary = {
  runId,
  time: new Date().toISOString(),
  baseUrl,
  authenticated: Boolean(token || cookie),
  readOnly: true,
  total: results.length,
  passed: results.filter(r => r.passed).length,
  failed: results.filter(r => !r.passed).length,
  timeouts: results.filter(r => r.error?.startsWith('timeout')).length,
  serverErrors: results.filter(r => r.status >= 500).length,
  results,
  note: token || cookie ? '使用运行时认证信息' : '未提供认证信息；401/403 表示接口需要登录，不等同于服务不可用',
};
await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));

await finishSuiteReport({
  suiteId: 'team_api',
  startedAt,
  checks: results.map((r) => ({
    key: r.id,
    status: r.passed ? 'passed' : 'failed',
    durationMs: r.elapsedMs,
    errorCode: r.passed ? null : (r.error?.startsWith('timeout') ? 'TIMEOUT' : `HTTP_${r.status || 'ERR'}`),
    message: `${r.method} ${r.path} → ${r.status ?? r.error}`.slice(0, 500),
  })),
});

if (summary.serverErrors || summary.timeouts) process.exitCode = 1;

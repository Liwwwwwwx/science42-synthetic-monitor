// 并发运行快检套件：basic_flow(quick) + case_catalog + markdown_render
// 案例批量（batch_cases / data_cases）保持串行：Science42 产品端任务队列串行，
// 案例并发只会让后提交的任务排队撞完成检测窗口（见 run-cases.mjs 注释与实测）。
// 用法：npm run test:quick
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 快检套件均为单文件单测试（页面交互类，不提交长任务队列），进程级并发安全。
const SUITES = [
  { name: '基础功能快检', script: 'monitor:basic' },
  { name: '案例列表', script: 'test:case-catalog' },
  { name: '富文本渲染', script: 'test:markdown' },
];

// 每套件硬超时：超过则强制终止并记为失败，避免子进程卡死导致脚本永不退出。
const CHILD_TIMEOUT_MS = 15 * 60_000;

console.log(`并发运行 ${SUITES.length} 个快检套件…`);

const results = [];
const children = new Set();
let nextId = 0;
let pending = 0;
// 收到外部终止信号时统一杀掉全部子进程。
process.on('SIGINT', () => { for (const c of children) c.kill('SIGKILL'); process.exit(130); });
process.on('SIGTERM', () => { for (const c of children) c.kill('SIGKILL'); process.exit(143); });

function startOne() {
  if (nextId >= SUITES.length) return;
  const suite = SUITES[nextId++];
  const id = nextId;
  pending += 1;
  console.log(`[run ${id}] ${suite.name} 启动`);
  const child = spawn('npm', ['run', suite.script], {
    cwd: ROOT,
    env: {
      ...process.env,
      // 每个子进程独立 json 报告文件，避免并发写同一文件互相覆盖（playwright.config.mjs 读取）。
      PLAYWRIGHT_JSON_REPORT: path.join('results', `playwright-results-quick-${id}.json`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  let settled = false;
  child.stdout.on('data', (d) => { output += d; if (output.length > 65536) output = output.slice(-65536); });
  child.stderr.on('data', (d) => { output += d; if (output.length > 65536) output = output.slice(-65536); });
  const settle = (code, detail) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    children.delete(child);
    pending -= 1;
    const status = code === 0 ? 'PASSED' : 'FAILED';
    results.push({ name: suite.name, status, code, detail: detail || (code === 0 ? '' : `exit ${code}`), outputTail: output.slice(-1500) });
    console.log(`[run ${id}] ${suite.name} → ${status}${detail ? `（${detail}）` : ` (exit ${code})`}`);
    if (pending === 0) {
      finish();
    }
  };
  child.on('close', (code) => settle(code === null ? -1 : code));
  child.on('error', (err) => settle(-1, err.message));
  // 看门狗：子进程卡死时强制终止，避免脚本永不退出。
  const watchdog = setTimeout(() => {
    if (settled) return;
    console.log(`[run ${id}] ${suite.name} 超过 ${CHILD_TIMEOUT_MS / 60_000} 分钟未结束，强制终止`);
    child.kill('SIGKILL');
    settle(-1, '看门狗强制终止');
  }, CHILD_TIMEOUT_MS);
  watchdog.unref();
}

function finish() {
  console.log(`\n快检汇总（${results.length} 个套件）：`);
  for (const r of results) {
    console.log(`  ${r.status === 'PASSED' ? '✅' : '❌'} ${r.name} → ${r.status}${r.detail ? `（${r.detail}）` : ''}`);
    if (r.status !== 'PASSED') {
      console.log(r.outputTail.split('\n').filter(Boolean).slice(-12).map((l) => `      ${l}`).join('\n'));
    }
  }
  const failed = results.filter((r) => r.status !== 'PASSED');
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  // 父级汇总落盘：被看门狗 SIGKILL 的子进程没有 playwright 报告，此处保证有据可查。
  try {
    fs.mkdirSync(path.join(ROOT, 'results', 'runs', 'quick-suites'), { recursive: true });
    const summaryFile = path.join(ROOT, 'results', 'runs', 'quick-suites', `quick-suites-summary-${new Date().toISOString().replaceAll(':', '-')}.json`);
    fs.writeFileSync(summaryFile, JSON.stringify({
      capturedAt: new Date().toISOString(),
      passed: results.length - failed.length,
      total: results.length,
      results,
    }, null, 2), 'utf8');
  } catch (error) {
    console.error(`[quick-suites] 汇总落盘失败: ${error.message}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

for (let i = 0; i < SUITES.length; i += 1) startOne();

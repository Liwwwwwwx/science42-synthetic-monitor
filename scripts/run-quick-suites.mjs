// 并发运行快检套件：basic_flow(quick) + case_catalog + markdown_render
// 案例批量（batch_cases / data_cases）保持串行：Science42 产品端任务队列串行，
// 案例并发只会让后提交的任务排队撞完成检测窗口（见 run-cases.mjs 注释与实测）。
// 用法：npm run test:quick
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 快检套件均为单文件单测试（页面交互类，不提交长任务队列），进程级并发安全。
const SUITES = [
  { name: '基础功能快检', script: 'monitor:basic' },
  { name: '案例列表', script: 'test:case-catalog' },
  { name: '富文本渲染', script: 'test:markdown' },
];

console.log(`并发运行 ${SUITES.length} 个快检套件…`);

const results = [];
let nextId = 0;
let running = 0;

function startOne() {
  if (nextId >= SUITES.length) return;
  const suite = SUITES[nextId++];
  const id = running;
  running += 1;
  console.log(`[run ${id + 1}] ${suite.name} 启动`);
  const child = spawn('npm', ['run', suite.script], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', (code) => {
    running -= 1;
    const status = code === 0 ? 'PASSED' : 'FAILED';
    results.push({ name: suite.name, status, code, outputTail: output.slice(-1500) });
    console.log(`[run ${id + 1}] ${suite.name} → ${status} (exit ${code})`);
    if (running === 0) {
      finish();
    }
  });
  child.on('error', (err) => {
    running -= 1;
    results.push({ name: suite.name, status: 'FAILED', code: -1, outputTail: `spawn failed: ${err.message}` });
    console.log(`[run ${id + 1}] ${suite.name} → FAILED (spawn error)`);
    if (running === 0) {
      finish();
    }
  });
}

function finish() {
  console.log(`\n快检汇总（${results.length} 个套件）：`);
  for (const r of results) {
    console.log(`  ${r.status === 'PASSED' ? '✅' : '❌'} ${r.name} → ${r.status}${r.code === 0 ? '' : ` (exit ${r.code})`}`);
    if (r.status !== 'PASSED') {
      console.log(r.outputTail.split('\n').filter(Boolean).slice(-12).map((l) => `      ${l}`).join('\n'));
    }
  }
  const failed = results.filter((r) => r.status !== 'PASSED');
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

for (let i = 0; i < SUITES.length; i += 1) startOne();

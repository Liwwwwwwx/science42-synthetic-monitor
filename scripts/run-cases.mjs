// 一键批量跑已选案例：DRY_RUN 盘点 → 按卡片位置串行执行 → 汇总结果
// 用法：
//   node scripts/run-cases.mjs --category=physics --indices=2,5,10  # 多选卡片，按位置串行
//   node scripts/run-cases.mjs --dry               # 只盘点打印将跑的案例，不实际执行
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATEGORY_LABEL = { physics: '物理求解', math: '数学建模', material: '材料计算' };

const args = process.argv.slice(2);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const CATEGORY = opt('category', 'physics').toLowerCase();
const INDICES = opt('indices', '').split(',').filter(Boolean).map(Number);
// 默认串行：实测服务端任务队列是串行执行的，并发 ≥2 时后提交的任务排队撞超时
//（单跑 52-125s 全过；并发 2/5 全部 TIMEOUT）。并发只在服务端支持并行时再开启。
const PARALLEL = Number(opt('parallel', 1));
const RUN_TIMEOUT_MS = Number(opt('timeout', 300_000));
const DRY = args.includes('--dry');

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run run:cases -- --category=physics --indices=N,N [--dry]');
  console.log('--indices 从 1 开始；由管理端勾选卡片生成；--dry 仅盘点，不实际运行。');
  process.exit(0);
}

if (!CATEGORY_LABEL[CATEGORY]) {
  console.error(`未知分类：${CATEGORY}（可用 physics/math/material）`);
  process.exit(1);
}
if (INDICES.some((index) => !Number.isInteger(index) || index < 1) || new Set(INDICES).size !== INDICES.length) {
  console.error('--indices 必须是无重复的正整数列表，例如 --indices=2,5,10');
  process.exit(1);
}
if (INDICES.length === 0) {
  console.error('必须通过 --indices 选择至少一张案例卡片');
  process.exit(1);
}

const baseEnv = { ...process.env, CASE_CATEGORY: CATEGORY };

// ── 1. 盘点：DRY_RUN 收集案例名 ──────────────────────────────
console.log(`[1/3] 盘点「${CATEGORY_LABEL[CATEGORY]}」分类案例…`);
const dry = spawnSync(
  'npx', ['playwright', 'test', 'suites/batch-cases', '--project=chromium'],
  { cwd: ROOT, env: { ...baseEnv, CASE_DRY_RUN: '1', CASE_LIMIT: '0' }, encoding: 'utf8', timeout: 180_000 },
);
if (dry.status !== 0) {
  console.error(`盘点失败（exit ${dry.status}）：\n${dry.stdout?.slice(-2000)}`);
  process.exit(1);
}
const outDir = path.join(ROOT, 'results/runs/batch_cases', CATEGORY);
const files = readdirSync(outDir).filter((f) => f.startsWith('batch-case-results-')).sort();
const latest = JSON.parse(readFileSync(path.join(outDir, files[files.length - 1]), 'utf8'));
const discoveredTitles = latest.results.map((r) => r.title).filter(Boolean);
const selections = INDICES.map((position) => ({ position, title: discoveredTitles[position - 1] }));
if (selections.some((item) => !item.title)) {
  console.error(`指定卡片不存在；该分类共 ${discoveredTitles.length} 张。`);
  process.exit(1);
}
console.log(`    共 ${discoveredTitles.length} 个案例，本次多选 ${INDICES.length} 张：`);
selections.forEach((item) => console.log(`    ${item.position}. ${item.title}`));

if (DRY || selections.length === 0) {
  console.log(DRY ? '[dry] 仅盘点，不执行' : '无案例可跑');
  process.exit(0);
}

// ── 2. 并行执行：每案例一个独立进程 ───────────────────────────
console.log(`[2/3] 串行跑 ${selections.length} 个案例（并发 ${Math.min(PARALLEL, selections.length)}）…`);
const results = [];
let cursor = 0;
let running = 0;
let nextId = 0;

function startOne() {
  if (cursor >= selections.length) return;
  const selection = selections[cursor++];
  const { title, position } = selection;
  const id = nextId++;
  running++;
  console.log(`[run ${id + 1}] ${title} 启动`);
  const child = spawn(
    'npx', ['playwright', 'test', 'suites/batch-cases', '--project=chromium', '--workers=1'],
    {
      cwd: ROOT,
      env: { ...baseEnv, CASE_TITLE: title, CASE_CATALOG_INDEX: String(position), CASE_RUN_TIMEOUT_MS: String(RUN_TIMEOUT_MS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', (code) => {
    running--;
    const status = code === 0 ? 'PASSED' : 'FAILED';
    const line = output.split('\n').find((l) => l.includes(`[case 1/1]`)) || '';
    const m = /- (PASSED|FAILED|TIMEOUT|BLOCKED|DISCOVERED) \((\d+) ms\)/.exec(line);
    results.push({ position, title, status, code, durationMs: m ? Number(m[2]) : null, detail: m ? m[1] : '' });
    console.log(`[run ${id + 1}] #${position} ${title} → ${m ? m[1] : status}${m ? ` (${(m[2] / 1000).toFixed(0)}s)` : ''}`);
    startOne();
  });
}

const concurrency = Math.min(PARALLEL, selections.length);
for (let i = 0; i < concurrency; i++) startOne();

await new Promise((resolve) => {
  const timer = setInterval(() => { if (running === 0 && cursor >= selections.length) { clearInterval(timer); resolve(); } }, 1000);
});

// ── 3. 汇总 ──────────────────────────────────────────────────
console.log(`\n[3/3] 汇总（${results.length} 个案例）：`);
for (const r of results) {
  console.log(`  ${r.status === 'PASSED' ? '✅' : '❌'} #${r.position} ${r.title} → ${r.detail || (r.code === 0 ? 'PASSED' : `exit ${r.code}`)}${r.durationMs ? ` (${(r.durationMs / 1000).toFixed(0)}s)` : ''}`);
}
const failed = results.filter((r) => r.status !== 'PASSED');
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length > 0 ? 1 : 0);

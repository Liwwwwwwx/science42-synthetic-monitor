// 一键批量跑已选案例：DRY_RUN 盘点 → 按卡片位置串行执行 → 汇总结果
// 用法：
//   node scripts/run-cases.mjs --category=physics --indices=2,5,10  # 多选卡片，按位置串行
//   node scripts/run-cases.mjs --dry               # 只盘点打印将跑的案例，不实际执行
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATEGORY_LABEL = { physics: '物理求解', math: '数学建模', material: '材料计算', data: '数据建模' };

const args = process.argv.slice(2);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const CATEGORY = opt('category', 'physics').toLowerCase();
const INDICES = opt('indices', '').split(',').filter(Boolean).map(Number);
// 并发通过会话池隔离：每案例占用一个专用会话（--pool=N 槽位，默认 3），
// 实测同账号不同会话的任务可并行（3 任务同时通过）；同一会话并发会互相串扰
//（消息流/面板状态竞争）。产品端单账号并发容量实测上限 3，>3 会过载失败（SERVICE_DOWN/排队超时）。
const PARALLEL = Math.min(Math.max(Number(opt('parallel', 1)) || 1, 1), 3);
// 会话池大小：并发时案例按顺序取槽位独占会话；串行时轮训。上限即产品端实测并发容量 3。
const POOL = Math.min(Math.max(Number(opt('pool', 3)) || 1, 1), 3);
// 池必须不小于并发数：并发=池上限时全部案例同时启动，槽位不足会重复（会话冲突）。
const effectivePool = Math.max(POOL, PARALLEL);
// 默认超时按分类区分：数据建模（CAD 装配/三维网格）任务实测正常完成需 5-10 分钟，
// 300s 通用预算会截断仍在执行的正常任务；physics/math/material 保持 300s。
const DEFAULT_TIMEOUT_MS = CATEGORY === 'data' ? 660_000 : 300_000;
const RUN_TIMEOUT_MS = Number(opt('timeout', DEFAULT_TIMEOUT_MS));
const DRY = args.includes('--dry');

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run run:cases -- --category=physics --indices=N,N [--dry]');
  console.log('--indices 从 1 开始；由管理端勾选卡片生成；--dry 仅盘点，不实际运行。');
  process.exit(0);
}

if (!CATEGORY_LABEL[CATEGORY]) {
  console.error(`未知分类：${CATEGORY}（可用 physics/math/material/data）`);
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
  {
    cwd: ROOT,
    env: {
      ...baseEnv,
      CASE_DRY_RUN: '1',
      CASE_LIMIT: '0',
      PLAYWRIGHT_JSON_REPORT: path.join('results', `playwright-results-${CATEGORY}-dry.json`),
    },
    encoding: 'utf8', timeout: 180_000,
  },
);
if (dry.status !== 0) {
  const output = `${dry.stdout || ''}\n${dry.stderr || ''}`.trim();
  console.error(`盘点失败（exit ${dry.status}）：\n${output.slice(-6000)}`);
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
const children = new Set();
let cursor = 0;
let running = 0;
let nextId = 0;
// 收到外部终止信号时统一杀掉全部子进程，避免留下僵尸 playwright。
process.on('SIGINT', () => { for (const c of children) c.kill('SIGKILL'); process.exit(130); });
process.on('SIGTERM', () => { for (const c of children) c.kill('SIGKILL'); process.exit(143); });

function startOne() {
  if (cursor >= selections.length) return;
  const selection = selections[cursor++];
  const { title, position } = selection;
  const id = nextId++;
  // 会话池槽位：按案例启动顺序轮换（1..effectivePool），并发时同一时刻运行中的案例槽位互不重复。
  const slot = (id % effectivePool) + 1;
  running++;
  console.log(`[run ${id + 1}] ${title} 启动${PARALLEL > 1 ? `（会话 ${slot}）` : ''}`);
  const child = spawn(
    'npx', ['playwright', 'test', 'suites/batch-cases', '--project=chromium', '--workers=1'],
    {
      cwd: ROOT,
      env: {
        ...baseEnv,
        CASE_TITLE: title,
        CASE_CATALOG_INDEX: String(position),
        CASE_RUN_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
        CASE_CONVERSATION_SLOT: String(slot),
        // 每个子进程独立 json 报告文件，避免并发写同一文件互相覆盖（playwright.config.mjs 读取）。
        PLAYWRIGHT_JSON_REPORT: path.join('results', `playwright-results-${CATEGORY}-${position}-${id}.json`),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
    running--;
    const status = code === 0 ? 'PASSED' : 'FAILED';
    const line = output.split('\n').find((l) => l.includes(`[case 1/1]`)) || '';
    const m = /- (PASSED|FAILED|TIMEOUT|BLOCKED|DISCOVERED) \((\d+) ms\)/.exec(line);
    const reason = detail || (/\sreason=(.+)$/.exec(line)?.[1]?.trim() || '');
    results.push({ position, title, status, code, durationMs: m ? Number(m[2]) : null, detail: reason || (m ? m[1] : status) });
    console.log(`[run ${id + 1}] #${position} ${title} → ${reason || (m ? m[1] : status)}${m ? ` (${(m[2] / 1000).toFixed(0)}s)` : ''}`);
    startOne();
  };
  child.on('close', (code) => settle(code === null ? -1 : code));
  child.on('error', (err) => settle(-1, `子进程启动失败：${err.message}`));
  // 看门狗：子进程卡死（浏览器僵尸/npx 挂起）时强制终止并记为失败，避免脚本永不退出。
  const watchdog = setTimeout(() => {
    if (settled) return;
    console.log(`[run ${id + 1}] #${position} ${title} 超过 ${((RUN_TIMEOUT_MS + 300_000) / 1000).toFixed(0)}s 未结束，强制终止`);
    child.kill('SIGKILL');
    settle(-1, '看门狗强制终止');
  }, RUN_TIMEOUT_MS + 300_000);
  watchdog.unref();
}

const concurrency = Math.min(PARALLEL, selections.length);
for (let i = 0; i < concurrency; i++) startOne();

await new Promise((resolve) => {
  const timer = setInterval(() => { if (running === 0 && cursor >= selections.length) { clearInterval(timer); resolve(); } }, 1000);
});

// ── 3. 汇总 ──────────────────────────────────────────────────
const ordered = [...results].sort((a, b) => a.position - b.position);
console.log(`\n[3/3] 汇总（${results.length} 个案例）：`);
for (const r of ordered) {
  console.log(`  ${r.status === 'PASSED' ? '✅' : '❌'} #${r.position} ${r.title} → ${r.detail || (r.code === 0 ? 'PASSED' : `exit ${r.code}`)}${r.durationMs ? ` (${(r.durationMs / 1000).toFixed(0)}s)` : ''}`);
}
const failed = results.filter((r) => r.status !== 'PASSED');
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);

// 父级汇总落盘：子进程被看门狗 SIGKILL 时 spec 的写盘不会执行，
// 此文件保证被强制终止的案例也有本地记录可查（与后端 synthetic_tasks 入库互补）。
try {
  const summaryDir = path.join(ROOT, 'results', 'runs', 'batch_cases', CATEGORY);
  mkdirSync(summaryDir, { recursive: true });
  const summaryFile = path.join(summaryDir, `run-cases-summary-${new Date().toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(summaryFile, JSON.stringify({
    capturedAt: new Date().toISOString(),
    category: CATEGORY,
    parallel: PARALLEL,
    pool: POOL,
    passed: results.length - failed.length,
    total: results.length,
    results: ordered,
  }, null, 2), 'utf8');
} catch (error) {
  console.error(`[run-cases] 汇总落盘失败: ${error.message}`);
}

process.exit(failed.length > 0 ? 1 : 0);

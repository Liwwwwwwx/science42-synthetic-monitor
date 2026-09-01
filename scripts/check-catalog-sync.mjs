#!/usr/bin/env node
/**
 * 目录一致性巡检：比对 WS runner 的案例配置快照（shared/config/case-ws-jobs.json）
 * 与 Admin 后端静态案例目录（physics/data/material-case-catalog.json）。
 * 两份清单都来自开发机 sync-case-ws-config.mjs 的快照；产品前端改卡片后若未重跑
 * sync，快照会与后端目录不一致或整体过期，本巡检将对应检查项置为 failed。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishSuiteReport } from '../shared/report/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOBS_PATH = process.env.CASE_WS_JOBS_PATH || path.join(ROOT, 'shared/config/case-ws-jobs.json');
const BACKEND_DIR = process.env.SCIENCE_ADMIN_BACKEND_DIR || path.resolve(ROOT, '../backend');
const CATALOG_FILES = {
  physics: 'physics-case-catalog.json',
  data: 'data-case-catalog.json',
  material: 'material-case-catalog.json',
};
const MAX_AGE_DAYS = Number(process.env.SYNTHETIC_CATALOG_SYNC_MAX_AGE_DAYS || 14);

/** 纯比对：按 position 对齐，比较条数与标题；返回每类目的差异明细。 */
export function compareCatalogs(categories, catalogs) {
  const results = [];
  for (const [category, catalogFile] of Object.entries(CATALOG_FILES)) {
    const jobs = categories[category] || [];
    const catalog = catalogs[category] || [];
    const jobsByPosition = new Map(jobs.map((job) => [Number(job.position), String(job.title).trim()]));
    const catalogByPosition = new Map(catalog.map((item) => [Number(item.position), String(item.title).trim()]));
    const missing = [];
    const extra = [];
    const titleMismatch = [];
    for (const [position, title] of catalogByPosition) {
      if (!jobsByPosition.has(position)) missing.push(`#${position} ${title}`);
      else if (jobsByPosition.get(position) !== title) titleMismatch.push(`#${position} 目录「${title}」≠ 快照「${jobsByPosition.get(position)}」`);
    }
    for (const [position, title] of jobsByPosition) {
      if (!catalogByPosition.has(position)) extra.push(`#${position} ${title}`);
    }
    results.push({ category, catalogFile, jobsCount: jobs.length, catalogCount: catalog.length, missing, extra, titleMismatch });
  }
  return results;
}

function checkForResult(result) {
  const problems = [...result.missing, ...result.extra, ...result.titleMismatch];
  return {
    key: `catalog_${result.category}`,
    status: problems.length === 0 ? 'passed' : 'failed',
    message: problems.length === 0
      ? `${result.category}: 目录 ${result.catalogCount} 条与快照 ${result.jobsCount} 条一致`
      : `${result.category}: ${problems.slice(0, 5).join('；')}${problems.length > 5 ? ` 等 ${problems.length} 处差异` : ''}`,
  };
}

const startedAt = new Date();
const checks = [];
try {
  const [jobsRaw, stat] = await Promise.all([fs.readFile(JOBS_PATH, 'utf8'), fs.stat(JOBS_PATH)]);
  const jobs = JSON.parse(jobsRaw);
  const catalogs = {};
  const readErrors = [];
  for (const [category, file] of Object.entries(CATALOG_FILES)) {
    try {
      catalogs[category] = JSON.parse(await fs.readFile(path.join(BACKEND_DIR, 'src/modules/synthetic-monitoring', file), 'utf8'));
    } catch (error) {
      readErrors.push(`${category}: ${error.message}`);
      catalogs[category] = [];
    }
  }
  if (readErrors.length) checks.push({ key: 'catalog_readable', status: 'failed', message: readErrors.join('；').slice(0, 500) });
  const results = compareCatalogs(jobs.categories || {}, catalogs);
  checks.push(...results.map(checkForResult));
  const ageDays = (Date.now() - stat.mtime.getTime()) / 86400_000;
  checks.push({
    key: 'jobs_freshness',
    status: ageDays <= MAX_AGE_DAYS ? 'passed' : 'failed',
    message: `案例快照更新于 ${stat.mtime.toISOString()}（${ageDays.toFixed(1)} 天前，上限 ${MAX_AGE_DAYS} 天）；过期请在开发机重跑 npm run sync:case-ws-config`,
  });
} catch (error) {
  checks.push({ key: 'catalog_sync', status: 'failed', message: `无法读取案例快照或后端目录：${error.message}`.slice(0, 500) });
}

console.log(JSON.stringify({ suiteId: 'catalog_sync_check', checks }, null, 2));
await finishSuiteReport({ suiteId: 'catalog_sync_check', startedAt, checks });
if (checks.some((check) => check.status === 'failed')) process.exitCode = 1;

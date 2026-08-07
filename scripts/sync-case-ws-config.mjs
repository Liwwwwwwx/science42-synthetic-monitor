#!/usr/bin/env node
/**
 * 将 XIMUFORSCIENCE 的案例卡配置快照为 WS 批量 runner 的输入。
 * 仅在开发机执行；生产环境只读取生成后的 shared/config/case-ws-jobs.json。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = process.env.SCIENCE42_FRONTEND_DIR
  || path.resolve(ROOT, '../../../XIMUFORSCIENCE');
const OUTPUT = path.join(ROOT, 'shared/config/case-ws-jobs.json');

const SOURCES = [
  { category: 'physics', file: 'equationCards.ts', exportName: 'equationCards', defaultTeamType: 'physics_classical', includePde: true, sendFileMetadata: true },
  { category: 'data', file: 'nvidiaScienceCards.ts', exportName: 'nvidiaScienceCards', defaultTeamType: 'data', includePde: false, sendFileMetadata: false },
  { category: 'material', file: 'simulationCards.ts', exportName: 'simulationCards', defaultTeamType: 'materials', includePde: false, sendFileMetadata: false },
];

function loadCardArray(source, code) {
  const executable = code
    .replace(/^\s*import[^;]+;\s*$/gm, '')
    .replace(new RegExp(`export\\s+const\\s+${source.exportName}\\s*:\\s*ActionCard\\[\\]\\s*=`, 'm'), `const ${source.exportName} =`)
    .replace(new RegExp(`export\\s+const\\s+${source.exportName}\\s*=`, 'm'), `const ${source.exportName} =`)
    .concat(`\n;globalThis.__cards = ${source.exportName};`);
  const context = { globalThis: {} };
  vm.runInNewContext(executable, context, { filename: source.file, timeout: 1_000 });
  if (!Array.isArray(context.globalThis.__cards)) throw new Error(`${source.file} 未导出卡片数组`);
  return context.globalThis.__cards;
}

function toJob(card, source, position) {
  const param = Object.fromEntries((card.paramConfig || []).map(({ key, placeholder }) => [key, placeholder ?? '']));
  const prompt = String(card.defaultQuery || card.label || '').trim();
  if (!card.id || !card.label || !prompt) throw new Error(`${source.category} #${position} 缺少 id、label 或 prompt`);
  const job = {
    position,
    id: String(card.id),
    title: String(card.label).trim(),
    prompt,
    teamType: String(card.teamType || source.defaultTeamType),
    // data/material 卡片的 file_metadata 仅用于卡片展示；页面 Run 并不会发送它，不能在 WS 路径擅自加入。
    fileMetadata: source.sendFileMetadata && card.file_metadata ? (Array.isArray(card.file_metadata) ? card.file_metadata : [card.file_metadata]) : [],
  };
  if (source.includePde || card.path || card.teamType || (card.paramConfig || []).length > 0) {
    job.pdeImagePara = {
      type: String(card.label).trim(),
      path: String(card.path || ''),
      param,
    };
  }
  return job;
}

const categories = {};
for (const source of SOURCES) {
  const filePath = path.join(SOURCE_ROOT, 'app/components', source.file);
  const code = await fs.readFile(filePath, 'utf8');
  categories[source.category] = loadCardArray(source, code).map((card, index) => toJob(card, source, index + 1));
}

await fs.writeFile(OUTPUT, `${JSON.stringify({ version: 1, generatedFrom: 'XIMUFORSCIENCE action cards', categories }, null, 2)}\n`, 'utf8');
console.log(`已生成 ${OUTPUT}: ${Object.entries(categories).map(([name, items]) => `${name}=${items.length}`).join(', ')}`);

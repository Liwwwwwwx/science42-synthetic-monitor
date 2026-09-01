/**
 * 案例回答验收断言：物理/数据/材料三类案例的内容级判定。
 * 从 scripts/run-cases-ws.mjs 抽出以便单测；数据/材料逻辑保持原语义，
 * 物理步骤与完成标记的匹配做容错（兼容产品文案演进：Step N / 第N步 / 阶段N 等）。
 */
import { collectDataFlowStages, hasStlArtifact, isDataCaseComplete } from './data-case-assertions.mjs';

const STEP_ALIASES = ['step', '阶段', '第', 'phase', 'stage'];

/** 匹配"第 step 步/阶段/Step N"等阶段标题写法（step 后必须跟数字，避免 Step 1 误配 Step 10）。 */
export function hasStepHeading(content, step) {
  if (new RegExp(`第\\s*${step}\\s*(?:步|阶段)`, 'i').test(content)) return true;
  for (const alias of STEP_ALIASES) {
    if (new RegExp(`${alias}\\s*${step}(?!\\d)[\\s.、:：\\-－—]`, 'i').test(content)) return true;
  }
  return false;
}

export function allStepsPresent(content, steps = [1, 2, 3, 4, 5, 6]) {
  return steps.every((step) => hasStepHeading(content, step));
}

/** 截取 step 到 step+1 之间的区段，判断其中是否有代码块。 */
export function sectionForStep(content, step, next) {
  for (const alias of ['step', '阶段']) {
    const section = new RegExp(`${alias}\\s*${step}(?!\\d)[\\s.、:：][\\s\\S]*?(?=${alias}\\s*${next}(?!\\d)[\\s.、:：]|$)`, 'i').exec(content)?.[0];
    if (section) return section;
  }
  // 「第N步」写法：以第N步标题起，到第N+1步标题止
  return new RegExp(`第\\s*${step}\\s*(?:步|阶段)[\\s\\S]*?(?=第\\s*${next}\\s*(?:步|阶段)|$)`, 'i').exec(content)?.[0] || '';
}

export function stepHasCodeBlock(content, step, totalSteps = 6) {
  const next = Math.min(step + 1, totalSteps + 1);
  const section = sectionForStep(content, step, next);
  return /```|<pre\b|class=["'][^"']*code/i.test(section);
}

const COMPLETE_MARKERS = [
  /项目[\s\S]{0,160}(?:执行完成|已完成|运行完成|全部完成)/i,
  /(?:执行完成|运行完成|全部完成)/i,
];

/** 案例按类别生成内容验收项；每项 { key, ok, detail }。 */
export function buildCaseChecks(category, content) {
  const checks = [{ key: 'assistant_reply', ok: Boolean(String(content).trim()), detail: '本次请求已关联到持久化 assistant 回复' }];
  if (category === 'physics') {
    checks.push({ key: 'steps', ok: allStepsPresent(content), detail: 'Step 1-6' });
    checks.push({ key: 'code_blocks', ok: stepHasCodeBlock(content, 5) && stepHasCodeBlock(content, 6), detail: 'Step 5/6 代码块' });
    checks.push({ key: 'png', ok: /\.png\b|data:image\/png|!\[[^\]]*\]\([^)]*\.png/i.test(content), detail: 'PNG 产物' });
    checks.push({ key: 'complete', ok: COMPLETE_MARKERS.some((pattern) => pattern.test(content)), detail: '执行完成标记' });
  } else if (category === 'data') {
    // 业务链路与页面冒烟共用阶段判定：兼容产品文案演进，但仍要求规划和几何实体都完成。
    const stages = new Set(collectDataFlowStages(content));
    const stlArtifact = hasStlArtifact(content);
    checks.push({ key: 'cad_flow', ok: isDataCaseComplete(stages, true), detail: '建模方案与几何实体生成流程' });
    checks.push({ key: 'stl_file', ok: stlArtifact, detail: 'STL 文件产物' });
  } else {
    const retrieval = /中文检索项/.test(content) && /论文检索进度|检索概览|检索结果重排|文献检索/.test(content) && /综合回答/.test(content);
    const analysis = /材料名称核对|已入库性质|本轮建议|核心材料需求|候选材料|需求与瓶颈的关联/.test(content) && /追问推荐\s*[→>]?/.test(content);
    checks.push({ key: 'material_profile', ok: retrieval || analysis, detail: retrieval ? '检索综合型' : analysis ? '文本分析型' : '未识别材料 Profile' });
  }
  return checks;
}

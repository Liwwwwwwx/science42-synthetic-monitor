import test from 'node:test';
import assert from 'node:assert/strict';
import { allStepsPresent, buildCaseChecks, hasStepHeading, stepHasCodeBlock } from '../shared/case-answer-assertions.mjs';

function physicsAnswer({ stepWord = 'Step', complete = '项目执行完成', code = true } = {}) {
  const heading = (n) => (stepWord === 'Step' ? `Step ${n}` : stepWord === '第N步' ? `第${n}步` : `阶段 ${n}`);
  const steps = [1, 2, 3, 4, 5, 6].map((n) => {
    const fence = code && (n === 5 || n === 6) ? '\n```python\nprint(1)\n```' : '';
    return `## ${heading(n)}\n说明文字${n}${fence}`;
  }).join('\n\n');
  return `前置说明\n${steps}\n\n![结果](result.png)\n${complete}`;
}

function checkMap(content) {
  return Object.fromEntries(buildCaseChecks('physics', content).map((c) => [c.key, c.ok]));
}

test('物理验收：原有 Step N 文案仍然全部通过', () => {
  const map = checkMap(physicsAnswer());
  assert.deepEqual(map, { assistant_reply: true, steps: true, code_blocks: true, png: true, complete: true });
});

test('物理验收：第N步 / 阶段N 写法也能识别', () => {
  const di = checkMap(physicsAnswer({ stepWord: '第N步' }));
  assert.equal(di.steps, true);
  const phase = checkMap(physicsAnswer({ stepWord: '阶段N' }));
  assert.equal(phase.steps, true);
});

test('物理验收：完成标记的替代写法可通过，缺失则失败', () => {
  const alt = checkMap(physicsAnswer({ complete: '任务已全部完成' }));
  assert.equal(alt.complete, true);
  const missing = checkMap(physicsAnswer({ complete: '以上是全部输出' }));
  assert.equal(missing.complete, false);
});

test('物理验收：缺步骤/缺代码块/缺PNG 分别失败', () => {
  const missingStep = physicsAnswer().replace('## Step 3', '## 环节三');
  assert.equal(checkMap(missingStep).steps, false);
  const noCode = checkMap(physicsAnswer({ code: false }));
  assert.equal(noCode.code_blocks, false);
  const noPng = checkMap(physicsAnswer().replace('![结果](result.png)', '结果见上文'));
  assert.equal(noPng.png, false);
});

test('Step 1 不会误匹配 Step 10/12 标题', () => {
  assert.equal(hasStepHeading('Step 10 开始', 1), false);
  assert.equal(hasStepHeading('Step 12：收尾', 1), false);
  assert.equal(hasStepHeading('Step 1 开始', 1), true);
});

test('代码块判定：第N步写法的第5/6步代码块同样识别', () => {
  const content = '第1步 分析\n第2步 建模\n第3步 求解\n第4步 后处理\n第5步 生成代码\n```python\na=1\n```\n第6步 导出\n```python\nb=2\n```\n执行完成';
  assert.equal(stepHasCodeBlock(content, 5), true);
  assert.equal(stepHasCodeBlock(content, 6), true);
  assert.equal(allStepsPresent(content), true);
});

test('材料验收：检索综合型与文本分析型原语义保留', () => {
  const retrieval = buildCaseChecks('material', '中文检索项如下…文献检索完成，最终给出综合回答。');
  assert.equal(retrieval.find((c) => c.key === 'material_profile').ok, true);
  const analysis = buildCaseChecks('material', '材料名称核对通过，给出候选材料清单并附追问推荐 →');
  assert.equal(analysis.find((c) => c.key === 'material_profile').ok, true);
  const neither = buildCaseChecks('material', '这是一个普通回答。');
  assert.equal(neither.find((c) => c.key === 'material_profile').ok, false);
});

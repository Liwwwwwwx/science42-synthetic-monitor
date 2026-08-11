import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../shared/config/case-ws-jobs.json' with { type: 'json' };
import { collectDataFlowStages, dataCaseFailureReason, hasStlArtifact, isDataCaseComplete } from '../shared/data-case-assertions.mjs';

test('case WS configuration preserves the action-card routing contract', () => {
  assert.equal(config.version, 1);
  assert.equal(config.categories.physics.length, 42);
  assert.equal(config.categories.data.length, 9);
  assert.equal(config.categories.material.length, 7);

  const physics = config.categories.physics[0];
  assert.equal(physics.teamType, 'physics_classical');
  assert.deepEqual(physics.pdeImagePara.param, { n_boundary: '4096', alpha_evm: '0.03' });

  const data = config.categories.data[0];
  assert.equal(data.teamType, 'data');
  assert.deepEqual(data.fileMetadata, [], 'data card display metadata is not part of the UI Run payload');

  const material = config.categories.material[0];
  assert.equal(material.teamType, 'materials');
  assert.equal(material.prompt, '请帮我筛选适用于机器人高散热关节的3D打印材料。');
});

test('data assertions accept the current CAD transcript and structured STL filename', () => {
  const currentTranscript = [
    '正在分析装配需求并生成建模方案，请稍候...',
    '建模方案思考完成',
    '正在生成几何实体，请稍候...',
    '{"generated_files":["6eaa827fa5c7_step1.stl","6eaa827fa5c7_step1.step"]}',
    'CAD 装配任务已完成',
  ].join('\n');
  const stages = new Set(collectDataFlowStages(currentTranscript));

  assert.deepEqual([...stages].sort(), ['geometry', 'planning']);
  assert.equal(hasStlArtifact(currentTranscript), true);
  assert.equal(isDataCaseComplete(stages, true), true);
});

test('data assertions retain the legacy CAD transcript', () => {
  const legacyTranscript = '正在构思装配结构规划\n规划已交付，开始编写底层代码\n正在生成几何实体，请稍候\npart.stl';
  const stages = new Set(collectDataFlowStages(legacyTranscript));
  assert.equal(isDataCaseComplete(stages, hasStlArtifact(legacyTranscript)), true);
});

test('data assertion failure names the missing condition without blaming STL', () => {
  const stages = new Set(['planning', 'geometry']);
  assert.equal(dataCaseFailureReason(stages, false), '未检测到 STL 文件产物');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../shared/config/case-ws-jobs.json' with { type: 'json' };

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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROJECT } from '../shared/config/project.mjs';
import { writeLocalResult } from '../shared/report/index.mjs';

test('local synthetic results are private to the current user', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-result-'));
  const originalResultsDir = PROJECT.resultsDir;
  PROJECT.resultsDir = path.join(tempDir, 'runs');
  try {
    const result = await writeLocalResult({
      suiteId: 'security',
      runId: 'run-1',
      finishedAt: '2026-08-12T00:00:00.000Z',
      status: 'passed',
    });
    assert.equal((await fs.stat(path.dirname(result.file))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(result.latest)).mode & 0o777, 0o600);
  } finally {
    PROJECT.resultsDir = originalResultsDir;
    await fs.rm(tempDir, { recursive: true });
  }
});

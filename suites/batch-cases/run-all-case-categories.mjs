import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const categories = ['physics', 'math', 'material'];
const limit = process.env.CASE_LIMIT || '0';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: npm run test:batch-all');
  console.log('Optional: CASE_LIMIT=1 for a one-case smoke run; CASE_LIMIT=0 runs all cases.');
  process.exit(0);
}

for (const category of categories) {
  console.log(`\n=== ${category} ===`);
  const child = spawnSync(npmCommand, ['run', 'test:batch-cases'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CASE_CATEGORY: category, CASE_LIMIT: limit }
  });
  results.push({
    category,
    exitCode: child.status ?? 1,
    status: child.status === 0 ? 'PASSED' : 'FAILED',
    error: child.error?.message || '',
    signal: child.signal || ''
  });
}

const report = {
  capturedAt: new Date().toISOString(),
  categories,
  caseLimit: Number(limit),
  results
};
const outputDir = path.join('artifacts', 'internal-cases');
await fs.mkdir(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `all-category-summary-${new Date().toISOString().replaceAll(':', '-')}.json`);
await fs.writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8');
console.log(`\nSummary: ${outputFile}`);
process.exitCode = results.some(item => item.exitCode !== 0) ? 1 : 0;

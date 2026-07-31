import 'dotenv/config';
import { defineConfig } from '@playwright/test';
import { getTargetUrl, getStorageStatePath } from './shared/config/project.mjs';

export default defineConfig({
  testDir: './suites',
  testMatch: '**/*.spec.mjs',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: 'results/playwright-output',
  reporter: [
    ['list'],
    ['json', { outputFile: 'results/playwright-results.json' }],
  ],
  use: {
    baseURL: getTargetUrl(),
    headless: process.env.HEADLESS !== 'false',
    trace: 'off',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    storageState: process.env.SCIENCE42_STORAGE_STATE || getStorageStatePath(),
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

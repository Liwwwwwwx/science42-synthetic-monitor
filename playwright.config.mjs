import 'dotenv/config';
import { defineConfig } from '@playwright/test';

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
    baseURL: process.env.SCIENCE42_BASE_URL || 'http://192.168.0.112:23191',
    headless: process.env.HEADLESS !== 'false',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    storageState: process.env.SCIENCE42_STORAGE_STATE || undefined,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

import 'dotenv/config';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: 'artifacts/playwright-results.json' }]],
  use: {
    baseURL: process.env.SCIENCE42_BASE_URL || 'http://192.168.0.112:23191',
    headless: process.env.HEADLESS !== 'false',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    storageState: process.env.SCIENCE42_STORAGE_STATE || undefined
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});

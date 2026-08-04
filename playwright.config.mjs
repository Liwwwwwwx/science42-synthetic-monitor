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
    // 并发子进程（test:quick / run:cases --parallel>1）必须各自写独立文件，
    // 父脚本通过 PLAYWRIGHT_JSON_REPORT 注入唯一路径，避免互相覆盖损坏。
    ['json', { outputFile: process.env.PLAYWRIGHT_JSON_REPORT || 'results/playwright-results.json' }],
  ],
  use: {
    baseURL: getTargetUrl(),
    headless: process.env.HEADLESS !== 'false',
    trace: 'off',
    // 录屏改为默认关闭：ffmpeg 录制会持续吃 CPU/磁盘，批量跑多个案例时叠加多个实例会把机器拖垮。
    // 需要排查时临时改回 'retain-on-failure' 或设 VIDEO=on。
    video: process.env.VIDEO === 'on' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    storageState: process.env.SCIENCE42_STORAGE_STATE || getStorageStatePath(),
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { cfg } from '../../shared/config/test-config.mjs';
import { loginIfNeeded } from '../../shared/lib/helpers.mjs';
import { finishSuiteReport } from '../../shared/report/index.mjs';

const SUITE_ID = 'case_catalog';

test('研发案例目录与点击入口清单', async ({ page }, testInfo) => {
  const startedAt = new Date();
  test.setTimeout(60_000);
  await loginIfNeeded(page);
  await page.goto(cfg.entryPath, { waitUntil: 'domcontentloaded' });

  // 当前平台将案例入口放在首页的「新建会话」案例预览区，而非旧版 /cases 页面。
  const caseCards = page.locator('[class*="case-card"]');
  await expect(caseCards.first()).toBeVisible({ timeout: 20_000 });
  const titles = await page.locator('[class*="case-title-row"]').allTextContents();
  const cards = await caseCards.count();
  const snapshot = await page.locator('body').innerText();
  const categoriesDetected = {
    math: /数学建模|数学优化/.test(snapshot),
    physics: /物理求解|物理 AI|物理仿真/.test(snapshot),
    material: /材料计算|材料筛选/.test(snapshot),
  };
  const inventory = {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    cards,
    titles,
    categoriesDetected,
    executionEntry: {
      hasCasePreview: cards > 0,
      note: '首页案例预览区提供案例入口；本监控只核验目录与分类可见，不点击卡片以避免创建业务会话。',
    },
  };
  await fs.mkdir('results/runs/case_catalog', { recursive: true });
  await fs.writeFile('results/runs/case_catalog/catalog.json', JSON.stringify(inventory, null, 2), 'utf8');
  await testInfo.attach('catalog.json', { body: JSON.stringify(inventory, null, 2), contentType: 'application/json' });
  await finishSuiteReport({
    page, testInfo,
    suiteId: SUITE_ID,
    startedAt,
    checks: [
      {
        key: 'page_load',
        status: cards > 0 ? 'passed' : 'failed',
        durationMs: Date.now() - startedAt.getTime(),
        errorCode: cards > 0 ? null : 'CASE_CATALOG_EMPTY',
        message: `首页案例预览卡片数=${cards}`,
      },
      {
        key: 'category_math',
        status: categoriesDetected.math ? 'passed' : 'failed',
        durationMs: 0,
        errorCode: categoriesDetected.math ? null : 'NOT_DETECTED',
        message: '数学分类文案',
      },
      {
        key: 'category_physics',
        status: categoriesDetected.physics ? 'passed' : 'failed',
        durationMs: 0,
        errorCode: categoriesDetected.physics ? null : 'NOT_DETECTED',
        message: '物理分类文案',
      },
      {
        key: 'category_material',
        status: categoriesDetected.material ? 'passed' : 'failed',
        durationMs: 0,
        errorCode: categoriesDetected.material ? null : 'NOT_DETECTED',
        message: '材料分类文案',
      },
    ],
  });

  expect(inventory.cards, '首页案例预览区未发现可用案例卡片').toBeGreaterThan(0);
});

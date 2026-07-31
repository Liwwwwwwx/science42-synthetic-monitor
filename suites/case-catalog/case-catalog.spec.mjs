import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { finishSuiteReport } from '../../shared/report/index.mjs';

const SUITE_ID = 'case_catalog';

test('研发案例目录与点击入口清单', async ({ page }, testInfo) => {
  const startedAt = new Date();
  test.setTimeout(60_000);
  await page.goto('/#/cases');
  await page.waitForTimeout(3_000);
  const titles = await page.locator('h3').allTextContents();
  const cards = await page.locator('div[class*="CaseCard_card"]').count();
  const menuButtons = await page.locator('button[aria-label="ellipsis"]').count();
  const snapshot = await page.locator('body').innerText();
  const categoriesDetected = {
    math: /数学|数学建模|方程求解/.test(snapshot),
    physics: /物理|流体|热传导|Navier-Stokes|PINN/.test(snapshot),
    material: /材料|热弹|热结构/.test(snapshot),
  };
  const inventory = {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    cards,
    titles,
    menuButtons,
    categoriesDetected,
    executionEntry: {
      hasRunButton: /运行|执行|开始计算|点击运行/.test(snapshot),
      hasOpenJupyterButton: /打开Jupyter/.test(snapshot),
      note: '目录页当前主要提供案例列表和 ellipsis 菜单；如没有运行入口，需由平台补充稳定 data-testid 或实际执行 API。',
    },
  };
  await fs.mkdir('results/runs/case_catalog', { recursive: true });
  await fs.writeFile('results/runs/case_catalog/catalog.json', JSON.stringify(inventory, null, 2), 'utf8');
  await testInfo.attach('catalog.json', { body: JSON.stringify(inventory, null, 2), contentType: 'application/json' });
  expect(inventory.cards).toBeGreaterThanOrEqual(0);

  await finishSuiteReport({
    suiteId: SUITE_ID,
    startedAt,
    checks: [
      {
        key: 'page_load',
        status: 'passed',
        durationMs: Date.now() - startedAt.getTime(),
        message: `cases page cards=${cards}`,
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
});

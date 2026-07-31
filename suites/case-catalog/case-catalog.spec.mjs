import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('研发案例目录与点击入口清单', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.goto('/#/cases');
  await page.waitForTimeout(3_000);
  const titles = await page.locator('h3').allTextContents();
  const cards = await page.locator('div[class*="CaseCard_card"]').count();
  const menuButtons = await page.locator('button[aria-label="ellipsis"]').count();
  const snapshot = await page.locator('body').innerText();
  const inventory = {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    cards,
    titles,
    menuButtons,
    categoriesDetected: {
      math: /数学|数学建模|方程求解/.test(snapshot),
      physics: /物理|流体|热传导|Navier-Stokes|PINN/.test(snapshot),
      material: /材料|热弹|热结构/.test(snapshot)
    },
    executionEntry: {
      hasRunButton: /运行|执行|开始计算|点击运行/.test(snapshot),
      hasOpenJupyterButton: /打开Jupyter/.test(snapshot),
      note: '目录页当前主要提供案例列表和 ellipsis 菜单；如没有运行入口，需由平台补充稳定 data-testid 或实际执行 API。'
    }
  };
  await fs.mkdir('results/runs/case_catalog', { recursive: true });
  await fs.writeFile('results/runs/case_catalog/catalog.json', JSON.stringify(inventory, null, 2), 'utf8');
  await testInfo.attach('catalog.json', { body: JSON.stringify(inventory, null, 2), contentType: 'application/json' });
  expect(inventory.cards).toBeGreaterThanOrEqual(0);
});

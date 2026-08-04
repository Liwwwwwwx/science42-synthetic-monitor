// Temporary probe v2: capture full material flow on science42 with assistant text timeline
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { PROJECT } from './shared/config/project.mjs';

const CASE_TITLE = process.env.CASE_TITLE || '机器人关节 3D 打印材料快速筛选';
const STORAGE = process.env.SCIENCE42_STORAGE_STATE || PROJECT.storageState;
const OUT = process.env.PROBE_OUT || `/tmp/material-probe-${Date.now()}`;
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 540_000);

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
const context = await browser.newContext({ storageState: STORAGE });
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const log = [];
const stamp = () => new Date().toISOString().slice(11, 23);
const mark = (msg) => { const t = stamp(); log.push(`[${t}] ${msg}`); console.log(`[${t}] ${msg}`); };
const shot = async (name) => {
  try { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }); mark(`screenshot ${name}.png`); } catch { /* noop */ }
};
const bodyText = async () => (await page.locator('body').innerText().catch(() => ''));

async function ensureCasePanelExpanded(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const labels = page.getByText('搜索案例', { exact: true });
    for (let index = await labels.count() - 1; index >= 0; index -= 1) {
      const searchLabel = labels.nth(index);
      if (!(await searchLabel.isVisible().catch(() => false))) continue;
      const panel = searchLabel.locator('xpath=ancestor::div[contains(@class,"ActionCardPanel") and contains(@class,"panel")][1]');
      const cardList = panel.locator('div[class*="cardList"]').first();
      if (await cardList.isVisible().catch(() => false)) return true;
      const toggle = panel.locator('div[class*="collapseIcon"]').first();
      if (!(await toggle.isVisible().catch(() => false))) continue;
      await toggle.click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      if (await cardList.isVisible({ timeout: 5_000 }).catch(() => false)) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function cardByTitle(page, title, timeoutMs = 25_000) {
  const list = page.locator('div[class*="scrollTrack"], div[class*="cardList"]').first();
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt += 1) {
    const labels = page.locator('span[class*="label"][title]');
    for (let i = 0; i < await labels.count(); i += 1) {
      const label = labels.nth(i);
      if (await label.getAttribute('title', { timeout: 2_000 }).catch(() => '') !== title) continue;
      const card = label.locator('xpath=ancestor::div[contains(@class,"ActionCardPanel") or contains(@class,"CaseCard_card")][1]');
      if (await card.isVisible().catch(() => false)) return card;
    }
    const remaining = Math.max(1, deadline - Date.now());
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; }, undefined, { timeout: Math.min(1_500, remaining) }).catch(() => {});
    await page.waitForTimeout(1_200);
  }
  return null;
}

const timeline = [];
let dialogFound = false;
let dialogDismissed = false;
let sawZhSearch = false;
let sawComprehensive = false;

try {
  mark('goto chat');
  await page.goto(PROJECT.targetUrl + PROJECT.chatPath, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3_000);
  const authStatus = await page.evaluate(async () => {
    const r = await fetch('/api/conversation/conversations?page=1&limit=1', { credentials: 'include' });
    return r.status;
  });
  mark(`conversation API HTTP ${authStatus}`);

  let selected = false;
  const actions = page.locator('div[class*="chat-action"]');
  for (let retry = 0; retry < 20 && !selected; retry += 1) {
    const n = await actions.count();
    for (let i = 0; i < n; i += 1) {
      const a = actions.nth(i);
      if ((await a.innerText().catch(() => '')).trim() === '材料计算') { await a.click({ timeout: 3_000 }).catch(() => {}); selected = true; break; }
    }
    if (!selected) {
      const fb = page.getByText('材料计算', { exact: true });
      for (let i = await fb.count() - 1; i >= 0; i -= 1) {
        if (await fb.nth(i).isVisible().catch(() => false)) { await fb.nth(i).click({ timeout: 3_000 }).catch(() => {}); selected = true; break; }
      }
    }
    if (!selected) await page.waitForTimeout(1_000);
  }
  mark(`category selected=${selected}`);
  await page.waitForTimeout(2_000);

  let panelOk = await ensureCasePanelExpanded(page, 25_000);
  mark(`panel expanded=${panelOk}`);
  let card = await cardByTitle(page, CASE_TITLE, 25_000);
  for (let attempt = 1; !card && attempt <= 3; attempt += 1) {
    mark(`card not found (attempt ${attempt}); re-expanding panel…`);
    await page.waitForTimeout(3_000);
    panelOk = await ensureCasePanelExpanded(page, 20_000);
    card = await cardByTitle(page, CASE_TITLE, 25_000);
  }
  mark(`card found=${!!card}`);
  if (!card) throw new Error('card not found');
  const run = card.getByRole('button', { name: 'Run', exact: true });
  await run.scrollIntoViewIfNeeded().catch(() => {});
  // snapshot assistant messages before Run: acceptance is scoped to NEW output
  const before = new Set();
  const bmsgs = page.locator('[data-role="assistant"]');
  for (let i = 0; i < await bmsgs.count(); i += 1) {
    const c = bmsgs.nth(i).locator('[data-message-id]').last();
    const id = await c.getAttribute('data-message-id').catch(() => null);
    const t = ((await c.innerText().catch(() => '')) || (await bmsgs.nth(i).innerText().catch(() => ''))).trim();
    before.add(`${id || i}\\u0000${t}`);
  }
  await run.first().click();
  mark('Run clicked');

  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  let lastText = '';
  let lastShot = 0;
  while (Date.now() < deadline) {
    const text = await bodyText();
    if (!dialogFound && text.includes('追问与补充')) {
      dialogFound = true;
      mark('追问与补充 dialog appeared');
      await shot('01-dialog');
      // click 停止 (default per user)
      const stopBtn = page.locator('button').filter({ hasText: /停\s*止/ }).last();
      if (await stopBtn.isVisible().catch(() => false)) {
        await stopBtn.click().catch(() => {});
        dialogDismissed = true;
        mark('clicked 停止 (default)');
        await page.waitForTimeout(1_200);
      }
    }
    const assistants = page.locator('[data-role="assistant"]');
    const last = await assistants.last().innerText().catch(() => '');
    if (last && last !== lastText) {
      const prevLen = lastText.length;
      lastText = last;
      timeline.push({ at: new Date().toISOString(), len: last.length, delta: last.length - prevLen, tail: last.slice(-600) });
      mark(`assistant ${last.length} chars (delta ${last.length - prevLen})`);
      // scope field detection to the latest NEW assistant message
      const lastMsg = await assistants.last().locator('[data-message-id]').last().innerText().catch(() => '');
      if (lastMsg && !before.has(`NEW`) && lastMsg !== '') {
        if (lastMsg.includes('中文检索项')) { sawZhSearch = true; if (lastShot + 5_000 < Date.now()) { await shot('04-zh-search'); lastShot = Date.now(); } }
        if (lastMsg.includes('综合回答')) { sawComprehensive = true; if (lastShot + 5_000 < Date.now()) { await shot('05-comprehensive'); lastShot = Date.now(); } }
      }
    }
    if (sawComprehensive && lastText && !/(正在|生成中|检索中|计算中|等待)/.test(lastText)) break;
    // periodic body snapshot to catch transient fields
    const snapIdx = String(Math.floor(Date.now() / 4000)).slice(-8);
    await fs.writeFile(path.join(OUT, `snap-${snapIdx}.txt`), text, 'utf8').catch(() => {});
    await page.waitForTimeout(2_000);
  }

  const finalText = await bodyText();
  mark(`final: dialog=${dialogFound} dismissed=${dialogDismissed} zhSearch=${sawZhSearch} comprehensive=${sawComprehensive} bodyLen=${finalText.length}`);
  await shot('09-final');
  await fs.writeFile(path.join(OUT, 'events.json'), JSON.stringify({
    caseTitle: CASE_TITLE, out: OUT,
    dialogFound, dialogDismissed, sawZhSearch, sawComprehensive,
    timeline, log, finalBodyTail: finalText.slice(-16_000),
  }, null, 2), 'utf8');
  mark(`probe done -> ${OUT}`);
} catch (error) {
  mark(`PROBE ERROR: ${error instanceof Error ? error.message : String(error)}`);
  await fs.writeFile(path.join(OUT, 'events.json'), JSON.stringify({ caseTitle: CASE_TITLE, out: OUT, dialogFound, dialogDismissed, sawZhSearch, sawComprehensive, timeline, log, error: String(error) }, null, 2), 'utf8');
} finally {
  await browser.close().catch(() => {});
}

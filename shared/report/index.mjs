import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT, getReportConfig } from '../config/project.mjs';

/**
 * Project-wide reporter: all suites share one Admin runner credential.
 * Missing credentials → local results only (tests still pass).
 */

/**
 * @param {object} input
 * @param {string} input.suiteId
 * @param {'passed'|'failed'|'error'} input.status
 * @param {Array<{key:string,status:string,durationMs:number,errorCode?:string|null,message?:string|null}>} input.checks
 * @param {string|Date} input.startedAt
 * @param {string|Date} [input.finishedAt]
 * @param {string|null} [input.errorSummary]
 * @param {number} [input.sequence]
 * @param {string} [input.runId]
 */
export function buildEnvelope(input) {
  const startedAt = new Date(input.startedAt);
  const finishedAt = new Date(input.finishedAt || Date.now());
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  const checks = (input.checks || []).map((c) => ({
    key: c.key,
    status: c.status,
    durationMs: Math.round(Number(c.durationMs) || 0),
    errorCode: c.errorCode || null,
    message: c.message ? String(c.message).slice(0, 500) : null,
    messageZh: c.messageZh ? String(c.messageZh).slice(0, 500) : null,
    failureReason: c.failureReason ? String(c.failureReason).slice(0, 1000) : null,
    failureReasonZh: c.failureReasonZh ? String(c.failureReasonZh).slice(0, 1000) : null,
  }));
  return {
    schemaVersion: 1,
    projectId: PROJECT.id,
    targetUrl: PROJECT.targetUrl,
    suiteId: input.suiteId,
    runId: input.runId || crypto.randomUUID(),
    sequence: input.sequence || Date.now(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    status: input.status,
    checks,
    errorSummary: input.errorSummary || null,
  };
}

/** Backend API payload (current Admin contract). */
export function toBackendPayload(envelope) {
  const summaryPrefix = `[${envelope.suiteId}] `;
  let errorSummary = envelope.errorSummary;
  if (errorSummary) {
    errorSummary = `${summaryPrefix}${errorSummary}`.slice(0, 500);
  } else if (envelope.suiteId) {
    // Keep suite identity visible in Admin until suiteId column exists
    errorSummary = null;
  }
  return {
      runId: envelope.runId,
      sequence: envelope.sequence,
      startedAt: envelope.startedAt,
      finishedAt: envelope.finishedAt,
      durationMs: envelope.durationMs,
      status: envelope.status,
      checks: envelope.checks,
      errorSummary: envelope.errorSummary,
      suiteId: envelope.suiteId || null,
    };
}

export async function writeLocalResult(envelope) {
  const dir = path.join(PROJECT.resultsDir, envelope.suiteId || 'unknown');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, `${envelope.finishedAt.replaceAll(':', '-')}-${envelope.runId}.json`);
  const latest = path.join(dir, 'latest.json');
  const body = JSON.stringify(envelope, null, 2);
  await fs.writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
  await fs.writeFile(latest, body, { encoding: 'utf8', mode: 0o600 });
  await Promise.all([fs.chmod(file, 0o600), fs.chmod(latest, 0o600)]);
  return { file, latest };
}

async function postReport(envelope, evidence = {}) {
  const { reportUrl, runnerId, token, configured } = getReportConfig();
  if (!configured) {
    return { skipped: true, reason: 'missing_project_admin_credentials' };
  }

  const form = new FormData();
  form.set('payload', JSON.stringify(toBackendPayload(envelope)));
  if (evidence.screenshot) {
    const buf = await fs.readFile(evidence.screenshot);
    form.set('screenshot', new Blob([buf], { type: 'image/png' }), path.basename(evidence.screenshot));
  }

  const response = await fetch(
    `${reportUrl}/api/synthetic-monitoring/runners/${encodeURIComponent(runnerId)}/runs`,
    {
      method: 'POST',
      headers: { 'X-Synthetic-Monitor-Token': token },
      body: form,
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`report rejected HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const json = await response.json().catch(() => ({}));
  return { skipped: false, ...json };
}

async function spool(envelope, evidence = {}) {
  const { spoolDir } = getReportConfig();
  await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 });
  const name = `${envelope.finishedAt.replaceAll(':', '-')}-${envelope.runId}.json`;
  await fs.writeFile(
    path.join(spoolDir, name),
    JSON.stringify({ report: toBackendPayload(envelope), suiteId: envelope.suiteId, evidence }),
    { mode: 0o600 },
  );
}

export async function flushSpool() {
  const { reportUrl, runnerId, token, configured, spoolDir } = getReportConfig();
  if (!configured) return { flushed: 0 };

  let flushed = 0;
  const files = (await fs.readdir(spoolDir).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
  for (const file of files) {
    const full = path.join(spoolDir, file);
    try {
      const item = JSON.parse(await fs.readFile(full, 'utf8'));
      const envelope = { ...item.report, suiteId: item.suiteId || 'unknown' };
      await postReport(envelope, item.evidence || {});
      await fs.unlink(full);
      flushed += 1;
    } catch {
      /* keep */
    }
  }
  return { flushed };
}

export async function publishResult(envelope, evidence = {}) {
  const safeEvidence = evidence && evidence.screenshot ? { screenshot: evidence.screenshot } : {};
  await flushSpool();
  const local = await writeLocalResult(envelope);
  try {
    const report = await postReport(envelope, safeEvidence);
    if (report.skipped) {
      console.log(`[report] ${envelope.suiteId} → 仅本地 (${report.reason})；全项目共用一套 ADMIN_* 凭证即可上报`);
    } else {
      console.log(`[report] ${envelope.suiteId} → Admin runId=${envelope.runId} duplicate=${!!report.duplicate}`);
    }
    return { local, report };
  } catch (error) {
    await spool(envelope, safeEvidence);
    console.warn(`[report] ${envelope.suiteId} 上报失败已入 spool: ${error.message}`);
    return { local, report: { skipped: false, spooled: true, error: error.message } };
  }
}

export function mapItemStatus(status) {
  if (status === 'completed' || status === 'passed' || status === 'PASSED' || status === 'DISCOVERED') return 'passed';
  if (status === 'error' || status === 'BLOCKED') return 'error';
  return 'failed';
}

/**
 * Build envelope from checks and publish (local + optional Admin).
 * @param {{ suiteId: string, startedAt: Date|string, checks: Array, errorSummary?: string|null, evidence?: object }} input
 */
export async function finishSuiteReport(input) {
  const checks = input.checks || [];
  const allPassed = checks.length > 0 && checks.every((c) => c.status === 'passed');
  const hasError = checks.some((c) => c.status === 'error');
  const status = allPassed ? 'passed' : hasError && !checks.some((c) => c.status === 'failed') ? 'error' : 'failed';
  const envelope = buildEnvelope({
    suiteId: input.suiteId,
    status,
    checks,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt || new Date(),
    errorSummary:
      input.errorSummary
      ?? (status === 'passed' ? null : checks.filter((c) => c.status !== 'passed').map((c) => c.key).join(',')),
  });
  let evidence = input.evidence && input.evidence.screenshot ? { screenshot: input.evidence.screenshot } : {};
  if (status !== 'passed' && input.page && input.testInfo) {
    try {
      const screenshot = input.testInfo.outputPath('failure.png');
      await fs.mkdir(path.dirname(screenshot), { recursive: true });
      await input.page.screenshot({ path: screenshot, fullPage: true });
      evidence = { screenshot };
    } catch {
      // The page may already be closed after a test failure; the report remains useful without evidence.
    }
  }
  return publishResult(envelope, evidence);
}

/** Normalize a check key: lowercase snake, max 64. */
export function checkKey(raw, fallback = 'item') {
  const s = String(raw || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return s && /^[a-z]/.test(s) ? s : `c_${s || fallback}`.slice(0, 64);
}

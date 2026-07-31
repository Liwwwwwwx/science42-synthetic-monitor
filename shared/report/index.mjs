import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Unified suite/runner report envelope for Science Admin synthetic monitoring.
 * When Runner credentials are missing, only writes local results/ (dev-friendly).
 */

const SPOOL_DIR = process.env.MONITOR_SPOOL_DIR || 'results/spool';

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
  }));
  return {
    schemaVersion: 1,
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

/** Backend payload: omit suiteId (not validated yet); keep API-compatible fields. */
export function toBackendPayload(envelope) {
  return {
    runId: envelope.runId,
    sequence: envelope.sequence,
    startedAt: envelope.startedAt,
    finishedAt: envelope.finishedAt,
    durationMs: envelope.durationMs,
    status: envelope.status,
    checks: envelope.checks,
    errorSummary: envelope.errorSummary,
  };
}

export async function writeLocalResult(envelope) {
  const dir = path.join('results', 'runs', envelope.suiteId || 'unknown');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${envelope.finishedAt.replaceAll(':', '-')}-${envelope.runId}.json`);
  const latest = path.join(dir, 'latest.json');
  const body = JSON.stringify(envelope, null, 2);
  await fs.writeFile(file, body, 'utf8');
  await fs.writeFile(latest, body, 'utf8');
  return { file, latest };
}

async function postReport(envelope, evidence = {}) {
  const reportUrl = (process.env.SYNTHETIC_MONITOR_REPORT_URL || '').replace(/\/$/, '');
  const runnerId = process.env.SYNTHETIC_MONITOR_RUNNER_ID || '';
  const token = process.env.SYNTHETIC_MONITOR_RUNNER_TOKEN || '';
  if (!reportUrl || !runnerId || !token) {
    return { skipped: true, reason: 'missing_runner_credentials' };
  }

  const form = new FormData();
  form.set('payload', JSON.stringify(toBackendPayload(envelope)));
  if (evidence.screenshot) {
    const buf = await fs.readFile(evidence.screenshot);
    form.set('screenshot', new Blob([buf], { type: 'image/png' }), path.basename(evidence.screenshot));
  }
  if (evidence.trace && envelope.status !== 'passed') {
    const buf = await fs.readFile(evidence.trace);
    form.set('trace', new Blob([buf], { type: 'application/zip' }), path.basename(evidence.trace));
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
  await fs.mkdir(SPOOL_DIR, { recursive: true, mode: 0o700 });
  const name = `${envelope.finishedAt.replaceAll(':', '-')}-${envelope.runId}.json`;
  await fs.writeFile(
    path.join(SPOOL_DIR, name),
    JSON.stringify({ report: toBackendPayload(envelope), suiteId: envelope.suiteId, evidence }),
    { mode: 0o600 },
  );
}

export async function flushSpool() {
  const reportUrl = (process.env.SYNTHETIC_MONITOR_REPORT_URL || '').replace(/\/$/, '');
  const runnerId = process.env.SYNTHETIC_MONITOR_RUNNER_ID || '';
  const token = process.env.SYNTHETIC_MONITOR_RUNNER_TOKEN || '';
  if (!reportUrl || !runnerId || !token) return { flushed: 0 };

  let flushed = 0;
  const files = (await fs.readdir(SPOOL_DIR).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
  for (const file of files) {
    const full = path.join(SPOOL_DIR, file);
    try {
      const item = JSON.parse(await fs.readFile(full, 'utf8'));
      const envelope = { ...item.report, suiteId: item.suiteId || 'unknown' };
      await postReport(envelope, item.evidence || {});
      await fs.unlink(full);
      flushed += 1;
    } catch {
      /* keep spool entry */
    }
  }
  return { flushed };
}

/**
 * Write local result, try upload; spool on failure. Never throws for missing credentials.
 * @returns {Promise<{local: object, report: object}>}
 */
export async function publishResult(envelope, evidence = {}) {
  await flushSpool();
  const local = await writeLocalResult(envelope);
  try {
    const report = await postReport(envelope, evidence);
    if (report.skipped) {
      console.log(`[report] ${envelope.suiteId} saved locally only (${report.reason})`);
    } else {
      console.log(`[report] ${envelope.suiteId} uploaded runId=${envelope.runId} duplicate=${!!report.duplicate}`);
    }
    return { local, report };
  } catch (error) {
    await spool(envelope, evidence);
    console.warn(`[report] ${envelope.suiteId} upload failed, spooled: ${error.message}`);
    return { local, report: { skipped: false, spooled: true, error: error.message } };
  }
}

/** Map Playwright item status to report check status. */
export function mapItemStatus(status) {
  if (status === 'completed' || status === 'passed') return 'passed';
  if (status === 'error') return 'error';
  return 'failed';
}

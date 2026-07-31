/**
 * Project-fixed settings for Science42 frontend test/monitor module.
 * Target site and paths are not per-suite / not Admin-UI configurable.
 * Only secrets (login + optional one-time Admin runner) come from env.
 */

export const PROJECT = {
  /** Stable product id for this whole repo */
  id: 'science42_frontend',
  name: 'Science42 前端测试与监控',

  /** Fixed target under test */
  targetUrl: 'https://www.science42.tech',
  entryPath: '/#/cases',
  chatPath: '/#/chat',

  /** Default storage state path */
  storageState: 'shared/auth/.auth/science42.json',

  /** Local result roots */
  resultsDir: 'results/runs',
  spoolDir: 'results/spool',
};

/**
 * Resolve Admin report endpoint + single project runner.
 * One credential set for ALL suites/runners in this repo.
 */
export function getReportConfig() {
  const reportUrl = (
    process.env.ADMIN_URL
    || process.env.SYNTHETIC_MONITOR_REPORT_URL
    || ''
  ).replace(/\/$/, '');

  const runnerId =
    process.env.ADMIN_RUNNER_ID
    || process.env.SYNTHETIC_MONITOR_RUNNER_ID
    || '';

  const token =
    process.env.ADMIN_RUNNER_TOKEN
    || process.env.SYNTHETIC_MONITOR_RUNNER_TOKEN
    || '';

  const spoolDir =
    process.env.MONITOR_SPOOL_DIR
    || PROJECT.spoolDir;

  return {
    reportUrl,
    runnerId,
    token,
    spoolDir,
    configured: Boolean(reportUrl && runnerId && token),
  };
}

/** Base URL for Playwright / monitors (fixed product; env only to override temporarily). */
export function getTargetUrl() {
  return (process.env.SCIENCE42_BASE_URL || PROJECT.targetUrl).replace(/\/$/, '');
}

export function getStorageStatePath() {
  return process.env.SCIENCE42_STORAGE_STATE || PROJECT.storageState;
}

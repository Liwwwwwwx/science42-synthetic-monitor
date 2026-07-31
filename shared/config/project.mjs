/**
 * Project-fixed settings for Science42 frontend test/monitor module.
 * Target site is fixed; only secrets come from env.
 */

export const PROJECT = {
  id: 'science42_frontend',
  name: 'Science42 前端测试与监控',
  targetUrl: 'https://www.science42.tech',
  entryPath: '/#/cases',
  chatPath: '/#/chat',
  storageState: 'shared/auth/.auth/science42.json',
  resultsDir: 'results/runs',
  spoolDir: 'results/spool',
};

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
  const spoolDir = process.env.MONITOR_SPOOL_DIR || PROJECT.spoolDir;
  return {
    reportUrl,
    runnerId,
    token,
    spoolDir,
    configured: Boolean(reportUrl && runnerId && token),
  };
}

export function getTargetUrl() {
  return (process.env.SCIENCE42_BASE_URL || PROJECT.targetUrl).replace(/\/$/, '');
}

export function getStorageStatePath() {
  return process.env.SCIENCE42_STORAGE_STATE || PROJECT.storageState;
}

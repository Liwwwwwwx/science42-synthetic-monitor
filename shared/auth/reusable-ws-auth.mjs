import fs from 'node:fs/promises';
import { getStorageStatePath } from '../config/project.mjs';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function userNameFromValue(value) {
  const text = nonEmpty(value);
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return nonEmpty(parsed);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['user_name', 'username', 'userName', 'name', 'account']) {
        if (nonEmpty(parsed[key])) return nonEmpty(parsed[key]);
      }
    }
  } catch { /* userName is commonly a plain string */ }
  return text;
}

/**
 * 优先复用固定 token 或 Playwright 已保存的 auth-token，避免每次 WS 巡检重新登录并挤掉已有会话。
 * 不输出 token，也不把它写回工作区；storageState 本身已处于 ignored 私有目录。
 */
export async function loadReusableWsAuth(baseUrl, storageStatePath = getStorageStatePath()) {
  const configuredToken = nonEmpty(process.env.SCIENCE42_TOKEN);
  const configuredUserName = nonEmpty(process.env.SCIENCE42_USER_NAME);
  if (configuredToken && configuredUserName) return { token: configuredToken, userName: configuredUserName, source: 'environment' };

  let state;
  try { state = JSON.parse(await fs.readFile(storageStatePath, 'utf8')); } catch { return null; }
  const hostname = new URL(baseUrl).hostname;
  const token = (state.cookies || []).find((cookie) => cookie?.name === 'auth-token'
    && typeof cookie.value === 'string'
    && (hostname === cookie.domain?.replace(/^\./, '') || hostname.endsWith(`.${String(cookie.domain || '').replace(/^\./, '')}`)))?.value?.trim();
  const origin = (state.origins || []).find((item) => item?.origin === new URL(baseUrl).origin);
  const userName = userNameFromValue((origin?.localStorage || []).find((item) => item?.name === 'userName')?.value);
  if (token && userName) return { token, userName, source: 'storage-state' };
  return null;
}

export function isAutomaticReloginAllowed() {
  return process.env.SCIENCE42_ALLOW_RELOGIN === 'true';
}

import { PROJECT } from './project.mjs';

export const cfg = {
  entryPath: process.env.SCIENCE42_ENTRY_PATH || PROJECT.entryPath,
  chatPath: process.env.SCIENCE42_CHAT_PATH || PROJECT.chatPath,
  user: process.env.SCIENCE42_USER,
  password: process.env.SCIENCE42_PASSWORD,
  maxTaskMs: Number(process.env.MAX_TASK_MS || 75_000),
  smokeWaitMs: Number(process.env.SMOKE_WAIT_MS || 30_000),
  selectors: {
    username: process.env.SELECTOR_USERNAME || 'input[placeholder*="手机号"], input[placeholder*="邮箱"]',
    password: process.env.SELECTOR_PASSWORD || 'input[placeholder="密码"], input[type="password"]',
    login: process.env.SELECTOR_LOGIN || 'button:has-text("登录")',
    input: process.env.SELECTOR_CHAT_INPUT || 'textarea, input[placeholder*="提问"], input[placeholder*="问题"]',
    send: process.env.SELECTOR_SEND || 'button:has-text("发送"), button.chat-input_chat-input-send__3Z_FN_',
  },
};

export function requireEnv(name, value) {
  if (!value) throw new Error(`Missing ${name}. Set it as a process environment variable.`);
}

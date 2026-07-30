# Science42 平台核心流程自动化测试实施交接说明

## 1. 做了什么

本次测试不是在平台内让 AI 自己测试，而是使用 Playwright、k6 和 Node.js 编写自动化脚本，从浏览器真实用户链路和 HTTP 层两个角度验证平台：

```text
登录 → 进入聊天 → 输入问题 → 发送请求 → 接收回答
     → 判断流式/生成状态 → 校验实际返回 → 刷新 → 验证会话恢复
```

每条问题都带有唯一标识，脚本从页面中读取真实助手返回文本，并记录耗时、状态、失败现象和证据文件。

## 2. 工具和作用

| 工具 | 作用 | 运行入口 |
|---|---|---|
| Node.js 22 | 运行自动化脚本、报告和监控 | `node`、`npm` |
| Playwright | 浏览器登录、发送消息、读取流式结果、刷新恢复、截图和 Trace | `npm run test:core-regression` |
| Chromium | Playwright 使用的浏览器 | `npm run pw:install` |
| k6 | HTTP 探活、错误率、P95 响应时间和基础稳定性 | `k6 run .\k6\site-smoke.js` |
| Toxiproxy | 模拟延迟、断流、网络异常 | `tools\toxiproxy-server.exe`、`tools\toxiproxy-cli.exe` |
| Promptfoo | 固定问题集和输出格式评估 | 已安装，后续可接入格式回归 |
| DeepEval | 回答质量、相关性和完整性评估 | `.venv\Scripts\python.exe` |

## 3. 工程目录

```text
science42-test-suite/
├─ config/
│  ├─ test-config.mjs       # 站点地址、选择器、超时配置
│  └─ questions.json        # 固定问题集
├─ playwright/
│  ├─ auth-setup.mjs        # 首次登录并保存 storageState
│  ├─ helpers.mjs            # 登录、建会话、发送和耗时统计
│  ├─ s10.spec.mjs          # 多问题/新会话测试
│  ├─ s30b.spec.mjs         # 同一会话连续 30 条
│  ├─ session-recovery.spec.mjs # 刷新恢复
│  ├─ capture-responses.spec.mjs # 返回正文采集
│  └─ core-flow-regression.spec.mjs # 复杂核心流程回归
├─ monitor/
│  ├─ core-flow-monitor.mjs # 登录态、发送、回答和告警监控
│  └─ run-core-monitor.ps1  # Windows 运行入口
├─ k6/
│  └─ site-smoke.js         # HTTP 探活脚本
├─ artifacts/               # JSON、Markdown、截图和 Trace
├─ playwright.config.mjs    # Playwright 全局配置
└─ package.json              # npm 命令
```

## 4. 安装命令

在 PowerShell 中执行：

```powershell
cd C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite
npm install
npx playwright install chromium
```

检查工具版本：

```powershell
node --version
npm --version
npx playwright --version
k6 version
.venv\Scripts\python.exe -c "import deepeval; print(deepeval.__version__)"
```

## 5. 环境变量

账号和密码只通过运行时环境变量传入，不写进代码、报告和压缩包：

```powershell
$env:SCIENCE42_BASE_URL='http://192.168.0.112:23191'
$env:SCIENCE42_ENTRY_PATH='/#/cases'
$env:SCIENCE42_CHAT_PATH='/#/chat'
$env:SCIENCE42_USER='测试账号'
$env:SCIENCE42_PASSWORD='测试密码'
$env:SCIENCE42_STORAGE_STATE="$PWD\playwright\.auth\science42.json"
$env:MAX_TASK_MS='75000'
```

如果登录页面出现滑块验证码，需人工完成一次滑块，然后保存浏览器登录态；脚本不绕过验证码。

## 6. 首次登录命令

```powershell
npm run auth:setup
```

认证成功后确认文件存在：

```powershell
Test-Path .\playwright\.auth\science42.json
```

## 7. 已执行过的测试命令

### 7.1 固定问题测试

```powershell
npm run test:s10
```

### 7.2 同一会话连续发送

```powershell
npm run test:s30b
```

### 7.3 返回内容采集

```powershell
npm run capture:responses
```

### 7.4 会话刷新恢复

```powershell
npm run test:sr30
```

### 7.5 复杂核心流程回归

```powershell
$env:MAX_TASK_MS='75000'
npm run test:core-regression
```

该脚本覆盖：精确计算、严格 JSON、三点列表、HTTP 504 长文本、两轮上下文、刷新恢复，并把结果写入 `artifacts\core-flow-regression.json`。

### 7.6 HTTP 探活

```powershell
k6 run .\k6\site-smoke.js `
  -e BASE_URL=http://192.168.0.112:23191 `
  -e ITERATIONS=10 `
  -e INTERVAL_SECONDS=1
```

脚本判断：HTTP 200、页面未暂停、状态码不是 5xx，并统计 P95；今日结果为 10/10 请求通过、30/30 检查通过、P95 264.03 ms。

### 7.7 核心流程监控

```powershell
$env:SCIENCE42_MONITOR_URL='http://192.168.0.112:23191'
$env:SCIENCE42_STORAGE_STATE="$PWD\playwright\.auth\science42.json"
$env:MAX_TASK_MS='75000'
$env:ALERT_WEBHOOK_URL='告警机器人地址'
npm run monitor:core
```

监控脚本每次生成：

```text
artifacts/core-monitor/<时间>/result.json
artifacts/core-monitor/<时间>/page.png
artifacts/core-monitor/<时间>/trace.zip
artifacts/core-monitor/monitor-state.json
```

连续 2 次失败时进入告警状态；告警打开后连续 2 次成功时发送恢复通知。没有配置 `ALERT_WEBHOOK_URL` 时，只保存本地告警状态，不会发送外部通知。

## 8. 核心代码逻辑

### 8.1 登录态检查

文件：`playwright/helpers.mjs`

```javascript
export async function loginIfNeeded(page) {
  await page.goto(cfg.entryPath);
  const password = page.locator(cfg.selectors.password);
  if (await password.count() > 0) {
    requireEnv('SCIENCE42_USER', cfg.user);
    requireEnv('SCIENCE42_PASSWORD', cfg.password);
    await page.locator(cfg.selectors.username).fill(cfg.user);
    await password.fill(cfg.password);
    await page.locator(cfg.selectors.login).click();
  }
  if (await page.locator(cfg.selectors.input).count() === 0) {
    await page.goto(cfg.chatPath);
  }
  await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 20_000 });
}
```

### 8.2 发送消息并等待结果

核心逻辑是：填入带唯一标识的问题，按 Enter 发送，持续读取 `main` 区域，找到本次问题之后的助手内容，直到不再处于生成状态或达到超时阈值。

```javascript
const started = Date.now();
await input.fill(question);
await input.press('Enter');

let answer = '';
const deadline = Date.now() + MAX_TASK_MS;
while (Date.now() < deadline) {
  await page.waitForTimeout(500);
  const paragraphs = await page.locator('main p').allTextContents();
  const index = paragraphs.lastIndexOf(question);
  answer = index >= 0 ? (paragraphs[index + 1] || '').trim() : '';
  if (answer && !/生成中|Generating/i.test(answer)) break;
}

const result = {
  question,
  answer,
  elapsedMs: Date.now() - started,
  status: answer ? 'completed' : 'timeout'
};
```

### 8.3 结构化结果校验

不能只判断页面有文字，还要按问题类型校验：

```javascript
function checkJson(text) {
  try {
    const value = JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
    return value.name === 'Zhang San' && value.age === 18;
  } catch {
    return false;
  }
}

function checkExactNumber(text) {
  return text.trim() === '121932631112635269';
}

function checkThreeItems(text) {
  const lower = text.toLowerCase();
  return ['test', 'record', 'review'].every(item => lower.includes(item));
}
```

### 8.4 刷新恢复校验

```javascript
const before = await page.locator('main').innerText();
await page.reload({ waitUntil: 'domcontentloaded' });
await expect(page.locator(cfg.selectors.input)).toBeVisible({ timeout: 20_000 });
const after = await page.locator('main').innerText();

const restored = after.includes('[CORE-context-2]')
  && after.includes('ORANGE-42');
```

### 8.5 k6 探活代码

文件：`k6/site-smoke.js`

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

const base = __ENV.BASE_URL || 'http://192.168.0.112:23191';
export const options = {
  vus: Number(__ENV.VUS || 1),
  iterations: Number(__ENV.ITERATIONS || 10),
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<5000']
  }
};

export default function () {
  const res = http.get(`${base}/`);
  check(res, {
    'HTTP 200': r => r.status === 200,
    'not paused': r => !r.body.includes('This deployment is temporarily paused'),
    'not 5xx': r => r.status < 500
  });
  sleep(Number(__ENV.INTERVAL_SECONDS || 60));
}
```

## 9. 如何查看结果

```powershell
Get-Content .\artifacts\core-flow-live-results-2026-07-27.json
Get-Content .\artifacts\core-flow-execution-report-2026-07-27.md
Get-Content .\artifacts\daily-report-2026-07-27.md
Get-ChildItem .\test-results -Recurse -File
```

查看 Playwright Trace：

```powershell
npx playwright show-trace .\test-results\<测试目录>\trace.zip
```

## 10. 本次实际发现的缺陷

1. 要求只输出整数时，平台返回了计算过程和重复结果。
2. 列表问题返回上一条 JSON 的残片，存在结果串台或流式拼接污染。
3. 历史会话达到 100/100，影响新建会话测试。
4. 登录态过期后页面提示重新登录，自动化已能捕获该状态。
5. 页面历史中出现过 `{"error":true,"message":"empty response"}`，说明不能只用 HTTP 200 判断业务成功。

## 11. 尚未完成的部分

- Toxiproxy 延迟、断流、504/5xx 故障注入。
- 流式首包、增量事件和结束标记的接口级采集。
- 告警 webhook 的真实通知验证。
- 缺陷修复后的复测闭环。

原因是流式接口协议和告警接收地址尚未由平台侧明确提供；现有浏览器层、页面层和 HTTP 探活结果已经保留，可在这两个前置条件具备后直接继续。

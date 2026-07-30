# Science42 自动化测试与监控完整交付工程



## 目录结构

```text
science42-test-suite-v2/
├─ api/                 # 团队接口探活脚本
├─ config/              # 测试配置和问题集
├─ k6/                  # HTTP 探活和性能测试
├─ monitor/             # 核心流程监控和告警脚本
├─ playwright/          # 浏览器自动化测试
├─ artifacts/           # 综合报告、测试数据、证据和历史记录
│  ├─ 01_综合报告/      # 中文交付报告
│  ├─ 03_测试数据/      # 交付包中的测试数据
│  ├─ 04_测试证据/      # 交付包中的截图和 Trace
│  └─ ...               # 原始运行结果和历史报告
├─ package.json
├─ package-lock.json
├─ playwright.config.mjs
└─ README.md
```

## 安装和运行

在本目录执行：

```powershell
npm install
npx playwright install chromium
```

配置测试环境：

```powershell
$env:SCIENCE42_BASE_URL='http://192.168.0.112:23191'
$env:SCIENCE42_ENTRY_PATH='/#/cases'
$env:SCIENCE42_CHAT_PATH='/#/chat'
$env:SCIENCE42_STORAGE_STATE="$PWD\playwright\.auth\science42.json"
$env:MAX_TASK_MS='75000'
```

首次登录并保存状态：

```powershell
npm run auth:setup
```

如遇滑块验证码，需要人工完成一次验证；脚本不绕过验证码。

## 测试命令

```powershell
npm run test:s10
npm run test:s30b
npm run capture:responses
npm run test:sr30
npm run test:core-regression
npm run test:case-catalog
npm run probe:team-api
k6 run .\k6\site-smoke.js -e BASE_URL=http://192.168.0.112:23191 -e ITERATIONS=10 -e INTERVAL_SECONDS=1
```

核心流程监控：

```powershell
$env:SCIENCE42_MONITOR_URL='http://192.168.0.112:23191'
$env:ALERT_WEBHOOK_URL='告警Webhook地址'
npm run monitor:core
```

## 综合报告和交付材料

优先阅读：

```text
artifacts\consolidated-test-report-2026-07-28.md
artifacts\01_综合报告\综合测试报告.md
artifacts\01_综合报告\交付说明.md
```

综合报告包含测试范围、测试方法、执行命令、实际返回、测试结果、问题清单、团队接口阻塞原因和后续整改计划。

## 安全说明

- 不要提交 `playwright\.auth\`。
- 不要把真实账号、密码、Token 或 Cookie 写入代码和报告。
- 本目录合并时未复制 `node_modules` 和 `.venv`，运行 `npm install` 即可恢复 Node 依赖。


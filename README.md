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

本机已完成 Science Admin Runner 注册后，使用下列命令运行并上报。Runner Token 只从 macOS 钥匙串读取，不写入 `.env` 或仓库：

```bash
npm run monitor:core:admin-local
```

## 测试命令

研发案例批量自动化测试：

```powershell
$env:SCIENCE42_BASE_URL='https://science42.tech'
$env:SCIENCE42_ENTRY_PATH='/#/cases'
$env:SCIENCE42_USER='测试账号'
$env:SCIENCE42_PASSWORD='测试密码'
node playwright/auth-setup.mjs
$env:SCIENCE42_STORAGE_STATE="$PWD\playwright\.auth\science42.json"
$env:CASE_LIMIT='0'
npm run test:batch-all
```

该脚本自动选择物理、数学、材料分类，逐张卡片点击 `Run`，并保存输出、耗时和状态。`artifacts/` 仅保留本机测试结果，不提交到 Git。

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

接入 Science Admin 后，将 Runner ID、Runner Token 和 Admin 后端地址写入权限为 `0600` 的环境文件；`npm run monitor:core` 会将三个检查（登录态、聊天流式、刷新恢复）和失败证据上报。Linux 部署文件位于 `deploy/`，使用 `systemd` timer 每十分钟执行一次；网络不可用时运行结果保存在本地 spool，下次执行自动补报。

远程部署时以 `deploy/monitor.env.example` 为模板创建 `/etc/science42-synthetic-monitor/monitor.env`。首次登录命令读取该环境文件后，登录态会保存至 `/var/lib/science42-synthetic-monitor/science42.json`；后续 timer 会复用该登录态。

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

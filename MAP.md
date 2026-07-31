# 项目地图（先看这个）

本仓库做两件事，**目录按职责拆开**，不要混着记。

## 总览

```text
suites/     质量测试套件（本地/CI 跑；结果将进后端展示，suiteId 见 shared/suites.manifest.json）
runners/    持续链路拨测（已对接 Admin「链路拨测」页）
probes/     HTTP/API 探测
shared/     登录、helpers、配置、套件清单
load/       k6 压测
results/    运行时结果（统一落盘，gitignore）
artifacts/  历史交付报告（只读档案，不再写新结果）
deploy/     Linux systemd 部署
```

## 和 Admin 的关系

| 目录 | 现在前端有没有 | 说明 |
|------|----------------|------|
| `runners/core-link` | **有** `/monitoring/synthetic` | `monitor:core` 上报 |
| `suites/*` | 还没有 | 规划接入后端展示，id 已固定 |
| `probes/*` | 还没有 | 规划接入；≠ 前端「团队服务监控」整页 |

## 套件 ID（后端用这个，不要随便改）

见 `shared/suites.manifest.json`。

常用命令：

| npm | suite id |
|-----|----------|
| `npm run test:s10` | `smoke_s10` |
| `npm run test:s30b` | `long_chat_s30b` |
| `npm run test:core-regression` | `core_regression` |
| `npm run test:sr30` | `session_recovery` |
| `npm run test:case-catalog` | `case_catalog` |
| `npm run test:markdown` | `markdown_render` |
| `npm run capture:responses` | `capture_responses` |
| `npm run probe:team-api` | `team_api` |
| `npm run monitor:core` | `core_link`（已上报） |

## 结果落盘与上报

```text
results/runs/<suite_id>/latest.json   # 标准 Envelope
results/spool/                        # 上报失败排队
```

配齐 `SYNTHETIC_MONITOR_REPORT_URL` + `RUNNER_ID` + `RUNNER_TOKEN` 后，
`smoke_s10`（及后续接入的套件）会通过同一接口上报 Admin「链路拨测」。
未配置时只写本地，不影响测试通过。

实现：`shared/report/index.mjs`

## 首次本地

```bash
npm install && npm run pw:install
cp .env.example .env   # 填账号；BASE_URL 指向环境
npm run auth:setup     # 滑块验证一次，写 shared/auth/.auth/
npm run test:s10
```

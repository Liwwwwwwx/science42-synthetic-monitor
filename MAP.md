# 项目地图

## 这是什么

**一个固定产品的前端测试/监控模块**，只测：

```text
https://www.science42.tech
```

不是多租户、不需要在 Admin 前端里给每个测试配目标地址。

固定配置见：`shared/config/project.mjs`

## 目录

```text
shared/config/project.mjs   固定目标站 + 全项目上报配置读取
shared/report/              所有套件共用的上报
suites/                     质量测试（s10、长对话…）
runners/core-link/          定时链路拨测
probes/                     API 探测
results/                    本地结果
```

## 你要填的配置（尽量少）

`.env`：

```bash
# 登录 Science42（auth:setup / 自动登录需要）
SCIENCE42_USER=...
SCIENCE42_PASSWORD=...

# 上报 Admin —— 整项目一套，配一次
ADMIN_URL=https://你的-admin
ADMIN_RUNNER_ID=...
ADMIN_RUNNER_TOKEN=...
```

- **不配 Admin 三项**：测试照跑，结果只在 `results/`
- **配了**：所有套件共用这一套 Runner 上报（不必每个测试再配）

## 常用命令

```bash
npm run auth:setup          # 首次登录存状态
npm run monitor:basic       # 基础功能快检（定时巡检）
```

## 套件 ID

见 `shared/suites.manifest.json`（`basic_flow`、`case_catalog`…）

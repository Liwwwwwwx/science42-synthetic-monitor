# Science42 前端测试与监控

固定目标站：**https://www.science42.tech**（`shared/config/project.mjs`）。

先读 [MAP.md](./MAP.md)。

## 安装

```bash
npm install && npm run pw:install
cp .env.example .env
# 填 SCIENCE42_USER / SCIENCE42_PASSWORD
# 上报 Admin（可选，全项目一套）：ADMIN_URL / ADMIN_RUNNER_ID / ADMIN_RUNNER_TOKEN
npm run auth:setup
```

## 命令

```bash
npm run test:s10
npm run test:s30b
npm run test:core-regression
npm run test:case-catalog
npm run test:sr30
npm run test:markdown
npm run capture:responses

# 研发案例批量（物理/数学/材料）
CASE_LIMIT=1 npm run test:batch-cases   # 单分类冒烟
CASE_LIMIT=0 npm run test:batch-all     # 全部分类

npm run probe:team-api
npm run monitor:core
```

## 结果

- `results/runs/<suiteId>/`
- `results/playwright-output/`
- 批量案例摘要：`results/runs/batch_cases/`（或 artifacts/internal-cases 兼容路径）

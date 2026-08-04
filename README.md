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
npm run monitor:basic        # 基础功能快检（登录态 + 1 题真实问答，后台按钮与定时任务使用）
npm run test:basic           # 基础功能全量（登录态+10题冒烟+30轮长对话+刷新恢复，仅手动回归）
npm run test:case-catalog
npm run test:markdown

# 研发案例批量（物理/数学/材料）
CASE_LIMIT=1 npm run test:batch-cases
CASE_LIMIT=0 npm run test:batch-all
npm run run:cases -- --category=physics --indices=1,2,3,4,5

npm run probe:team-api
```

物理求解案例会额外校验 Step 1–6、Step 5/6 代码块、PNG 产物、案例关键字和“执行完成”；数学建模、材料计算只校验 Run 后新增回复和完成状态。

## 结果

- `results/runs/<suiteId>/`
- `results/playwright-output/`
- 批量案例：`results/runs/batch_cases/`

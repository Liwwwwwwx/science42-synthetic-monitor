# Science42 前端测试与监控

固定目标站：**https://www.science42.tech**（`shared/config/project.mjs`）。

先读 [MAP.md](./MAP.md)。

## 安装

```bash
# 生产环境固定部署到 /data/science-admin/science42-synthetic-monitor
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

# 页面 UI 批量回归（Playwright；保留验证卡片、按钮与渲染）
CASE_LIMIT=1 npm run test:batch-cases
CASE_LIMIT=0 npm run test:batch-all
npm run run:cases -- --category=physics --indices=1,2,3,4,5

# 长期业务轮询（默认推荐；不启动 Chromium）
npm run run:cases-ws -- --category=physics --indices=1,2,3 --parallel=3
npm run run:cases-ws -- --category=data --indices=1 --parallel=1
npm run run:cases-ws -- --category=material --indices=1 --parallel=1

npm run probe:team-api
```

`run:cases-ws` 复用聊天页案例卡的 `prompt`、`team_type`、`pde_image_para` 与文件元数据契约，按 `client_message_id` 回查持久化回答；每个并发槽使用不同会话。物理求解校验 Step 1–6、PNG 与完成；数据建模校验 CAD 流程与 STL；材料计算校验检索综合型或文本分析型 Profile。复杂页面交互（例如「追问与补充」）继续由 Playwright 路径覆盖。

## 结果

- `results/runs/<suiteId>/`
- `results/playwright-output/`
- 批量案例：`results/runs/batch_cases/`

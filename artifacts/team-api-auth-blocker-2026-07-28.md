# 团队接口登录验证阻塞记录

## 当前结果

已确认 OpenAPI 中团队接口使用 `OAuth2PasswordBearer`，只读探活接口共 6 个，未认证访问均返回：

```json
{"detail":"Not authenticated"}
```

没有出现超时、504 或 5xx。

## 认证尝试

按 OpenAPI 的 `UnifiedLoginRequest` 调用：

```text
POST /api/v1/user/login
```

请求体字段为 `account` 和 `password`，但当前地址返回 HTTP 404；因此 API 文档中的登录路由与实际网关路由不一致，无法安全猜测真实登录地址，也不能把未认证的 401 误判为团队接口不可用。

## 需要平台侧提供

请提供以下任一项：

1. 可用的实际登录 API 地址；或
2. 专用测试 Token；或
3. 专用测试 Cookie；以及
4. 测试团队 `group_id`、会话 ID 和团队输出预期值。

拿到这些信息后，直接执行：

```powershell
$env:SCIENCE42_API_TOKEN='测试Token'
$env:API_TIMEOUT_MS='10000'
npm run probe:team-api
```

脚本会记录每个接口的状态码、耗时、响应摘要、超时、504、5xx 和通过率，并写入：

```text
artifacts/team-api/<时间>/summary.json
```

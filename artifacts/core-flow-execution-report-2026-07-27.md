# Science42 平台核心流程自动化测试执行报告

## 1. 执行结论

本轮按照第二专项测试计划，在已登录测试环境的真实聊天页面执行了复杂场景回归，覆盖登录态确认、消息发送、回答返回、结果格式、上下文记忆和刷新恢复，并补做了 k6 HTTP 探活。

本轮发现两个需要整改的核心问题：

1. 严格格式控制不稳定：要求“只输出整数”的计算问题返回了推理过程和重复结果；要求“只输出代码词”的上下文问题也返回了额外解释。
2. 结果串台/污染：列表问题没有返回列表，而是返回了上一条 JSON 的残片 `":"Zhang San","age":18}`，说明前端展示、流式拼接或后端任务关联存在需要定位的问题。

同时确认：长文本回答、多轮上下文记忆、刷新后会话恢复正常；站点 HTTP 探活 10/10 通过，P95 为 264.03 ms，无 5xx。

## 2. 测试环境与方法

- 环境：`http://192.168.0.112:23191`
- 页面：`/#/cases`、`/#/chat`
- 工具：浏览器自动化、Playwright 工程、k6
- 执行方式：使用已登录浏览器会话，在已有聊天中追加带唯一标识的测试问题
- 结果采集：记录问题、页面实际显示内容、耗时、格式校验、上下文校验和刷新恢复状态
- 会话限制：页面显示“最近对话 100/100”，因此没有继续创建新会话，避免环境容量错误干扰核心流程结果。

## 3. 详细执行结果

| 用例 | 实际返回/现象 | 耗时 | 结果 |
|---|---|---:|---|
| 精确计算 | 返回计算过程，包含正确结果 `121932631112635269`，但不是只输出整数，且末尾出现重复结果 | 2125 ms | 格式失败 |
| 严格 JSON | `{"name":"Zhang San","age":18}` | 1106 ms | 通过 |
| 三点列表 | 返回 `":"Zhang San","age":18}`，为上一条 JSON 残片 | 2568 ms | 内容失败 |
| HTTP 504 长文本 | 完整解释网关超时、客户端超时区别，并列出两项排查步骤 | 4963 ms | 通过 |
| 上下文第一轮 | `ACK` | 3517 ms | 通过 |
| 上下文第二轮 | 正确返回 `ORANGE-42`，但附带解释文本 | 4845 ms | 内容正确但格式不严格 |
| 刷新恢复 | 刷新后问题、`ORANGE-42` 和输入框均恢复 | 7311 ms | 通过 |

原始结构化记录见：[core-flow-live-results-2026-07-27.json](C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite\artifacts\core-flow-live-results-2026-07-27.json)。

## 4. 站点 HTTP 探活结果

使用 k6 对测试环境执行 10 次低频 HTTP 探活：

- HTTP 请求：10
- 检查项：30
- 检查通过：30/30
- HTTP 失败率：0%
- 5xx：0
- P95：264.03 ms
- 检查内容：HTTP 200、页面未暂停、无 5xx

该结果只能说明站点 HTTP 层可访问，不能替代聊天流式回答和结果完整性测试。

## 5. 已发现问题与整改建议

### CORE-FINDING-001：严格输出约束未稳定生效

现象：计算问题要求“只输出整数”，实际返回了推理过程；上下文问题要求“只输出代码词”，实际返回了说明段落加代码词。

建议：

- 在结果判定层增加严格格式校验，失败时标记为业务失败而不是仅看 HTTP 200。
- 对“只输出”指令增加专门回归集，覆盖数字、JSON、代码词、固定枚举和固定行数。
- 若产品支持结构化输出，优先使用协议级 JSON/schema 约束，而不是只依赖提示词。

### CORE-FINDING-002：回答内容发生串台/残片污染

现象：列表问题返回上一条 JSON 尾部 `":"Zhang San","age":18}`。

建议按以下顺序定位：

1. 检查发送请求是否带有唯一 task/conversation/message ID。
2. 对照浏览器 Network 中本次请求的原始流式事件，确认残片来自服务端还是前端拼接。
3. 检查流式状态是否在上一请求结束前被复用，尤其是 AbortController、缓存变量和 React 状态。
4. 检查消息列表 key 是否使用稳定消息 ID，避免列表复用导致内容错位。
5. 增加“上一条 JSON + 下一条列表”连续回归用例，作为固定缺陷复测。

### CORE-FINDING-003：环境会话数量达到 100/100

现象：页面显示最近对话 100/100，创建新会话的 S-10 用例曾因此失败。

建议：为自动化准备专用账号或清理策略；清理动作必须经过项目负责人确认，不能由监控脚本无条件删除业务会话。

## 6. 历史记录索引

本轮没有删除或覆盖历史记录，相关文件包括：

- [增强回归结构化结果](C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite\artifacts\core-flow-live-results-2026-07-27.json)
- [旧版返回内容记录](C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite\artifacts\response-content.json)
- [返回内容专项报告](C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite\artifacts\response-content-report.md)
- [核心流程五项报告](C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite\artifacts\core-flow-five-items-report.md)
- [登录态过期回归结果](C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite\artifacts\core-flow-regression.json)
- 登录态过期截图和 Trace：`test-results/core-flow-regression-CORE--df3de-lt-context-save-and-restore-chromium/`
- [测试计划 V2](C:\Users\se42\Documents\Codex\2026-07-27\an-zh\outputs\science42-test-suite\artifacts\platform-core-flow-test-plan-v2.md)

## 7. 当前专项状态

本轮已完成正常链路、复杂数据、结果格式、上下文和刷新恢复测试，并确认 HTTP 探活正常；异常注入（断流、首包延迟、504）和告警 webhook 尚未完成，原因是当前测试环境的流式接口协议与告警接收渠道尚未明确。已发现问题应先完成整改，再按本报告中的固定问题执行复测。

# Bytebase MCP OAuth 验收计划

## 范围

验证插件能在不操作 Bytebase 页面表单的前提下完成 MCP OAuth 连接，并在客户端侧硬性限制数据库变更能力。

## 核心风险

- Token 被写入日志、配置或错误信息。
- Token 被发送到与登录时不同的 MCP 地址。
- Refresh Token 并发更新导致新凭据被旧值覆盖。
- Agent 通过 `call_api` 绕过工具白名单或自行审批。
- 创建工单时同时创建 Rollout，绕过审批等待阶段。
- 没有 DSH approval 服务时写操作仍然执行。

## 验证方法

- 使用 Node/Vitest 在临时目录和本地 fixture server 上验证，不接触生产数据。
- 使用 Windows DPAPI 做真实往返测试，但测试凭据仅为随机 fixture 且用后删除。
- 在线检查只访问公开发现端点和未认证 MCP 请求。
- 真实 OAuth 登录与 Bytebase 业务写入单列为人工 E2E，不以单元测试冒充。

# Bytebase MCP 透明调用验收计划

## 范围

验证插件不再以顶层工具白名单、`call_api.operationId` 白名单或 DSH approval 阻塞 Bytebase MCP，同时保留连接、工具同步、超时、错误投影与 OAuth 凭据安全。

## 核心风险

- 服务端新增工具后客户端仍静默过滤。
- `propose_database_change` 或 `call_api` 在没有交互式 approval prompt 的叶子 Runtime 中被插件拒绝。
- 删除门禁时误删工具名称规范化、重复检测、原子替换或超时处理。
- 文档继续声称存在客户端白名单，导致部署者错误估计权限边界。

## 验证方法

- 使用 MCP client fixture 发布已知和未来工具，断言全部注册。
- 通过真实 DSH ToolRuntime 调用任意 `call_api.operationId`，断言请求到达 MCP client 且不需要 approval 服务。
- 复跑完整类型检查、单元/协议集成测试、构建和打包检查。
- 使用已登录的真实 Bytebase MCP 只读执行工具发现，不执行真实数据库写入。

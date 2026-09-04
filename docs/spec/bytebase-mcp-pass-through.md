# Bytebase MCP 透明调用边界变更

## 现状与根因

首版插件同时限制 MCP 顶层工具、`call_api.operationId` 和写操作 approval。真实 Bytebase MCP 使用 `RolloutService/CreateRollout` 形式的 operationId，而首版白名单使用 `bytebase.v1.RolloutService.CreateRollout`，导致合法调用被误拒绝。更关键的是，群聊叶子 Runtime 禁用交互式 approval prompt；插件把 `propose_database_change` 固定返回 `ask` 后，即使任务已经通过群聊阻塞单获得业务批准，DSH ToolRuntime 仍会返回 `user rejected tool`。

## 目标

1. 注册 Bytebase MCP 服务端实际发布的全部工具，不在客户端维护第二份顶层工具白名单。
2. 将工具名称、参数和 `call_api.operationId` 原样转发给 Bytebase，不安装 `tools/pre-execute` approval 或客户端 guard。
3. 保留 OAuth URL 同源约束、Windows DPAPI 凭据保护、Token 刷新锁和结果投影。
4. 权限、SQL Review、工单审批、MCP capability 和审计由 Bytebase 服务端执行。

## 实现范围

- 删除固定工具及 operationId 常量。
- 删除工具分类、DSH approval waterfall 和拒绝 guard。
- 工具同步仍保留分页、重复名称检测、公共名称规范化、原子替换、超时和服务端错误投影。
- 测试验证未知的服务端工具会注册，任意 `call_api.operationId` 会到达 MCP client，且没有 approval 服务时也不会在本插件内拒绝。
- README 改为明确说明透明代理边界和 Bytebase 权限风险。

## 不在本次范围

- 不启动当前已停机的 DSH Web。
- 不执行真实 Bytebase 写操作，也不处理具体生产 SQL。
- 不把群聊阻塞单批准转换成通用 DSH approval ticket。

## 回滚

回退本变更即可恢复首版客户端白名单与 approval 门禁；回退后群聊叶子 Runtime 会再次无法调用写工具。

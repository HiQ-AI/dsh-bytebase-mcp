# Round 1 验收记录

## 结论

客户端顶层工具白名单、`call_api.operationId` 白名单和 DSH approval 门禁已移除。MCP fixture 证明服务端工具会完整注册，任意 operationId 会到达 MCP client；真实 Bytebase OAuth 只读工具发现通过。未执行真实数据库写入，也未把本次构建部署到已停机的 DSH Web。

## 根因证据

- 修复前调用 `RolloutService/CreateRollout` 返回“不在插件 operationId 白名单中”，而旧的 `bytebase.v1.RolloutService.CreateRollout` 才返回 `ask`；实时 MCP 工具说明和 `search_api` 均使用斜杠格式。
- `propose_database_change` 已在顶层白名单中，但首版策略固定返回 `ask`。群聊叶子 Runtime 禁用交互式 approval prompt，因此上游业务批准不能让这次工具调用通过。
- 只修正 operationId 不能解决 `propose_database_change` 的阻塞；本轮按用户明确要求删除整个客户端动作门禁。

## 自动化证据

执行：

```powershell
npm run check
npm exec -- vitest run tests/tools.spec.ts --reporter=verbose
git diff --check
```

结果：

- TypeScript 严格类型检查通过。
- Vitest 共 6 个测试文件、17 项测试全部通过。
- 工具桥专项 2/2 通过：未来服务端工具会注册；`propose_database_change(createRollout=true)` 与 `call_api(IssueService/ApproveIssue)` fixture 调用在没有 approval 服务时均被原样转发。
- 构建和 `npm pack --dry-run` 通过，包内 44 个文件，27.6 kB 压缩、109.0 kB 解包。
- 构建产物中不存在 `tools/pre-execute`、guard、旧白名单或客户端拒绝文案。
- `git diff --check` 通过，仅有工作区行尾转换提示。

## 真实只读证据

使用当前构建、已保存的 DPAPI OAuth 凭据连接 `https://bytebase.hiqdat.dev/mcp`，`tools/list` 返回 6 个工具：`call_api`、`get_schema`、`get_skill`、`propose_database_change`、`query_database`、`search_api`。

## 边界

- 没有执行任何真实 Bytebase 写操作，不能把 fixture 转发测试当作生产变更成功。
- 没有重新部署或启动本地 DSH Web；3080/18998 已回读为无监听，`DSH Web Local` 为 `Ready`。
- 删除客户端门禁后，部署者必须依赖 Bytebase RBAC、工作区 MCP capability、SQL Review、审批流和审计控制权限。

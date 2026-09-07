# Round 1

## 结论

源码与集成测试已通过；真实凭据已强制刷新，干净重启后 `get_schema` 与 `SELECT 1` 两个只读探针成功。分支产物尚未安装到本地 Web profile，因此部署项保持 PENDING。

## 证据

- 故障前两个独立工具实时返回 `HTTP 401 access token expired`；同期凭据文件仍显示 Access Token 尚未到本地记录的到期时间，排除了单纯“没有 Refresh Token”。
- 强制刷新后凭据更新时间和到期时间前移一小时，Refresh Token 仍存在。
- 干净重启后 `get_schema` 返回目标表结构；`SELECT 1 AS live_token_probe` 返回 1，延迟 14ms。
- 新增集成用例在初始会话建立后触发到期前刷新，断言 refresh 次数为 1、MCP initialize 次数增加且六个工具重新注册。
- `npm run check`：6 个测试文件、19 个测试全部通过；typecheck、build、`npm pack --dry-run` 通过。

## 边界

- 没有创建 Bytebase Issue、Plan 或 Rollout。
- 没有运行生产写 SQL。
- 原等待任务仅通过引用回复恢复，仍须自行复核既有授权绑定的 SQL 哈希与数据范围。

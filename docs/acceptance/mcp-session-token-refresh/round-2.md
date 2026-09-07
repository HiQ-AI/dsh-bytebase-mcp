# Round 2：本地部署

## 结论

commit `62e53ea` 对应固定产物已安装到本地 DSH Web，运行态、状态保留和 Bytebase 只读调用均通过。完整真实令牌周期尚未跨越，因此自动轮换的生产实证仍为 PENDING。

## 部署与运行态证据

- profile 依赖指向 `docs/tmp/dsh-web-local-62e53ea/zzusp-dsh-bytebase-mcp-0.1.0.tgz`；安装后的 `lib/connection.js` SHA-256 为 `47E60ECB2C91D6DC89A5B935811490690F902FACD563C242DB7087491B536C3D`，与分支构建一致。
- 首次启动暴露同批钉钉助理升级要求 storage domain 7；活动 v6 原介质 SHA-256 `DFCAE588...AED1F5A` 保持不变。按照 `topic-storage-migration.md`，先对完成归档且缺失群上下文的两个孤儿 Task 做显式对账，再以 `--check` 验证 `ready: true`，生成独立 v7 介质并切换 profile；迁移读回 `verified: true`。
- `DSH Web Local` 为 Running；同一进程监听 3080 与 18998；Web HTTP 200。
- Runtime `/health` 返回 `status=ok`、`transport=dws`、入站处理与出站授权均为 true、`recoveryIssueCount=0`；延迟回读仍为 ok。
- `/state/tasks` 中 `task-b4ae3cde-6a68-434c-8496-a4c121736b8a` 保留为 `waiting`，结果明确数据库纠正已完成、仅待外部页面/API验收，本轮未追加生产写入。

## Bytebase 只读证据

- 新建 MCP 会话后 `tools/list` 返回六个工具：`call_api`、`get_schema`、`get_skill`、`propose_database_change`、`query_database`、`search_api`。
- `get_schema(database=hiq_editor, schema=public, table=tw_process_doc)` 返回成功并命中目标表。
- `query_database(database=hiq_editor, statement=SELECT 1 AS live_token_probe)` 返回成功且结果为 1。

## 未闭环边界

- 本轮证明部署后当前令牌和新 MCP 会话可用；尚未在不重启、不人工刷新的条件下跨过一个完整 Access Token 周期，不能据此宣称真实自动轮换已完成验证。

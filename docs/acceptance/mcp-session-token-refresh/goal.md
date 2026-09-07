# Bytebase MCP 共享会话令牌刷新

> 状态：ACTIVE
> Goal ID：bytebase-mcp-session-token-refresh
> 最近维护：2026-09-07T14:05:00+08:00
> 权威目标：D:\project\dsh-bytebase-mcp\docs\acceptance\mcp-session-token-refresh\goal.md

## 总目标

让 Bytebase MCP 作为 DSH Runtime 的共享能力，在 Access Token 到期前自动刷新凭据并重建长连接会话，使主会话和叶子会话持续使用同一有效认证；将修复提交 PR 并部署到本地 DSH Web，完成源码、产物、运行态和只读 MCP 验证。

## 完成条件

- PR #2 的刷新与会话重建实现通过全量测试，并保持可审阅状态。
- 本地 Web profile 安装与修复提交绑定的固定 tarball，关键产物哈希一致。
- DSH Web 干净重启且持久运行，3080/18998、Web、Runtime health 和状态 API 正常。
- `get_schema` 与 `query_database(SELECT 1)` 使用 Runtime 共享认证成功；不执行额外生产写入。
- 明确一个完整真实令牌周期自动轮换是否已观察；未观察时不得宣称该层生产实证完成。

## 范围与约束

- MCP 工具、凭据和刷新机制不区分主会话与叶子会话。
- 不绕过 Bytebase MCP，不扩大既有 SQL、数据范围或业务授权。
- 不在 HiQLCD 生产变更任务运行期间重启 DSH Web。
- 不输出 Token、Cookie 或 OAuth 授权码。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 恢复失效认证并恢复叶子任务 | 两个实时只读探针成功，引用回复回读，任务离开认证等待态 | 已完成 | `round-1.md`；任务已完成数据库纠正并转为页面/API验收等待 |
| SG2 | 实现持久会话刷新 | 全量测试覆盖提前刷新、会话重建和六工具重注册 | 已完成 | commit `62e53ea`；19/19 tests |
| SG3 | 提交审阅 | PR 状态、base/head、正文与提交回读一致 | 已完成 | PR #2 OPEN/MERGEABLE |
| SG4 | 部署本地 Web | 固定产物安装、干净重启、哈希和运行态/只读 MCP 验证通过 | 已完成 | `round-2.md`；安装文件哈希 `47E60ECB...36C3D` |
| SG5 | 观察真实自动轮换 | 跨过至少一个完整 Access Token 周期后两个只读探针仍成功，且无人工刷新/重启 | 待验证 | 尚无当前实证 |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：不人工刷新、不重启 Runtime，跨过一个完整 Access Token 周期后再次执行 `get_schema` 与 `SELECT 1`，核对凭据更新时间和会话重建后的工具同步结果。
- 未闭环项：PR #2 尚未合并；一个完整真实令牌周期的自动轮换尚未观察。

## 进展

- 2026-09-05：强制刷新共享 OAuth 凭据并干净重启旧运行版本；`get_schema` 与 `SELECT 1` 成功，引用回复恢复原叶子任务。
- 2026-09-05：实现到期前刷新与主动重建 MCP 会话，`npm run check` 通过 6 个测试文件、19 个测试；创建 PR #2。
- 2026-09-07：回读 PR #2 仍为 OPEN/MERGEABLE；HiQLCD 任务已完成数据库纠正并稳定等待外部页面/API验收，允许执行本地 Web 重启；profile 仍安装旧产物。
- 2026-09-07：profile 安装 `62e53ea` 固定产物，安装文件哈希与分支构建一致；因同时升级的钉钉助理要求 storage domain 7，按迁移手册从停写的 v6 对账副本生成独立 v7 介质并切换 profile，未改写 v6 原介质。
- 2026-09-07：DSH Web 恢复运行，3080/18998 由同一进程监听，Web HTTP 200，Runtime health `ok`、DWS 入站/出站正常、`recoveryIssueCount=0`；目标 Task 保留为 `waiting`。新 MCP 会话列出六个工具，`get_schema` 与 `SELECT 1` 实时成功。

## 重大决策

- 刷新责任属于 Runtime 共享连接，不下放给叶子会话。
- 不能只更新加密凭据文件；必须在刷新成功后主动销毁旧 MCP 长连接并重新同步工具。
- 业务生产任务处于 running 时不部署，以免中断受控变更；进入 waiting/completed 后再重启。
- 迁移阻塞属于同批本地钉钉助理升级的 v6→v7 契约，不通过篡改版本号绕过；使用独立 v7 root 切换并保留原 v6 作为回退边界。

## 重要信息

- PR：https://github.com/HiQ-AI/dsh-bytebase-mcp/pull/2
- 修复提交：`62e53ead7824e8466f0ea04c0c729d6a54385c32`
- 已部署产物：`docs/tmp/dsh-web-local-62e53ea/zzusp-dsh-bytebase-mcp-0.1.0.tgz`
- HiQLCD 任务当前为 waiting，数据库纠正已完成；本轮不得追加任何生产写入。

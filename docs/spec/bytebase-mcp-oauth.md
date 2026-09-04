# Bytebase MCP OAuth 插件实施规格

> 本文是首版客户端白名单方案的实施快照。当前工具调用边界已由 [Bytebase MCP 透明调用边界变更](bytebase-mcp-pass-through.md) 取代。

## 目标

在 DeepSeek Harness 中直接连接 Bytebase 官方 Streamable HTTP MCP，替代对 Bytebase Web 页面的 UI 自动化。插件运行于 Windows 11 / PowerShell 7 / Node.js 24 环境，默认连接 `https://bytebase.hiqdat.dev/mcp`。

可验证完成条件：

1. 用户通过独立 CLI 完成一次 OAuth Authorization Code + PKCE 登录。
2. OAuth 客户端信息、访问令牌和刷新令牌使用 Windows CurrentUser DPAPI 加密后原子落盘。
3. DSH 启动后读取凭据并连接 `/mcp`；访问令牌过期前在跨进程文件锁内调用 MCP SDK 刷新，并原子回写新令牌。
4. Agent 只能看到插件明确允许的 Bytebase MCP 工具。
5. 创建数据库变更、创建 Rollout 和运行任务必须经过 DSH 原生 approval；未挂载 approval 服务时拒绝执行。
6. Agent 不能调用 Bytebase API 自行审批/拒绝工单，也不能通过通用 API 执行白名单之外的操作。

## 产品边界

### 插件负责

- OAuth 发现、动态客户端注册、PKCE、回调、Token 刷新和注销。
- 凭据与目标 MCP URL 绑定，防止向其他地址发送 Token。
- MCP 工具发现、筛选、注册、调用和结果投影。
- 对写操作接入 DSH `tools/pre-execute` approval。
- 对 `call_api.operationId` 做硬白名单校验。

### 插件不负责

- 不保存 Bytebase 用户名或密码。
- 不自动操作浏览器中的登录表单；浏览器只用于用户本人完成一次授权。
- 不替用户审批 Bytebase 工单。
- 不绕过 Bytebase RBAC、SQL Review、审批流或审计。
- 不提供 Skill；首版依靠精确工具描述和硬策略完成操作约束。

## 工具策略

直接暴露的官方 MCP 工具：

- `search_api`
- `get_skill`
- `get_schema`
- `query_database`
- `propose_database_change`
- `call_api`（仅允许下面的 operationId）

`propose_database_change` 必须审批，且强制 `createRollout=false`，确保“建工单”和“发布”分离。

`call_api` 只允许：

- 读取：`IssueService.GetIssue`、`IssueService.ListIssueComments`、`PlanService.GetPlan`、`PlanService.GetPlanCheckRun`、`RolloutService.GetRollout`、`RolloutService.ListTaskRuns`、`RolloutService.GetTaskRun`、`RolloutService.GetTaskRunLog`。
- 写入：`RolloutService.CreateRollout`、`RolloutService.BatchRunTasks`；两者必须经过 DSH approval。

所有其他 operationId 均在发出网络请求前拒绝。

## 认证与凭据

- OAuth 回调只监听 `127.0.0.1`，校验随机 `state`，并设置五分钟超时。
- 授权地址必须是无内嵌凭据的 HTTPS URL，且与 Bytebase MCP 同源。
- 凭据文件默认位于 `$DSH_HOME/.bytebase-mcp-auth.json`。
- 文件只保存版本号、保护方式和 DPAPI 密文；明文 Token 不写配置、不打印日志。
- 写入使用 `@deepseek-ai/dsh-atomic-write` 的文件锁和原子替换；刷新网络请求也位于同一把跨进程锁内，等待者回读先完成者的新令牌，避免旋转 Refresh Token 被并发重放。
- DSH 运行态不主动弹出 OAuth；无凭据或 Refresh Token 失效时停止连接并提示运行登录命令。

## CLI

```powershell
dsh-bytebase-mcp login
dsh-bytebase-mcp status
dsh-bytebase-mcp doctor
dsh-bytebase-mcp logout
```

- `login`：启动 loopback 回调、打印并打开授权 URL，成功后验证 MCP 工具发现。
- `status`：只输出登录状态与非敏感元数据。
- `doctor`：不读取 Token，检查 Node/平台和 OAuth/MCP 发现端点。
- `logout`：只删除本插件的凭据文件。

## 验证层级

1. 单元测试：URL 约束、凭据文档、工具筛选和写操作策略。
2. 本机测试：DPAPI 加解密与原子回读。
3. 协议集成测试：本地 OAuth + MCP fixture 验证授权码、刷新、工具注册和拒绝路径。
4. 在线只读探测：Bytebase 发现端点和未授权 `/mcp` 行为。
5. 真实 OAuth/真实业务 E2E 需要用户本人完成授权，不能由自动测试替代。

# @zzusp/dsh-bytebase-mcp

面向 DeepSeek Harness 的 Bytebase 官方 MCP 客户端插件。它使用 Bytebase 的 Streamable HTTP `/mcp` 端点和 OAuth Authorization Code + PKCE，不操作 Bytebase 页面表单。

## 安全边界

- OAuth Token 与登录时的 MCP URL 绑定，并使用 Windows CurrentUser DPAPI 加密。
- DSH 配置和日志中不出现 Access Token、Refresh Token、授权码或 PKCE verifier。
- 默认不暴露无限制的 `call_api`：只有代码内固定的查询与发布 operationId 可以执行。
- `propose_database_change` 必须经过 DSH approval，并拒绝 `createRollout=true`。
- 创建 Rollout 和运行任务必须分别经过 DSH approval。
- 插件不开放审批、拒绝、跳过、取消等 Bytebase API，Agent 不能替用户审批工单。

## 安装前检查

要求 Windows 11、PowerShell 7、Node.js 24 和 DSH `0.1.1-rc.2` 系列运行时。

```powershell
npm install
npm run check
```

当前源码目录可直接安装到本机 DSH Web profile：

```powershell
dsh plugin --profile web add "D:\project\dsh-bytebase-mcp"
```

安装会读取包内的 `cordis.patch.yml` 并加入插件配置。只检查最终配置、不安装时可运行：

```powershell
dsh --profile web --patch .\cordis.patch.yml --dump-config
```

## 登录

首次登录由用户本人在浏览器中完成：

在源码目录构建后登录：

```powershell
node .\lib\bin.js login
```

安装到 Web profile 后，也可以从该 profile 调用 CLI：

```powershell
dsh plugin --profile web exec dsh-bytebase-mcp login
```

默认 MCP 地址为 `https://bytebase.hiqdat.dev/mcp`。CLI 会在 `127.0.0.1:14801` 临时监听 OAuth 回调，成功后关闭监听，并验证能够读取 MCP 工具列表。

如果默认端口被占用，可显式指定：

```powershell
node .\lib\bin.js login --callback-port 14802
```

登录状态和无凭据诊断：

```powershell
node .\lib\bin.js status
node .\lib\bin.js doctor
```

删除本插件凭据：

```powershell
node .\lib\bin.js logout
```

## DSH 配置

安装包后会通过 `cordis.patch.yml` 插入：

```yaml
- id: bytebase-mcp
  name: '@zzusp/dsh-bytebase-mcp'
  config:
    url: https://bytebase.hiqdat.dev/mcp
    failOnStartupError: false
```

可配置项：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `url` | `https://bytebase.hiqdat.dev/mcp` | Bytebase MCP 端点；必须是 HTTPS，loopback 测试地址可使用 HTTP |
| `credentialPath` | `$DSH_HOME/.bytebase-mcp-auth.json` | DPAPI 密文文件；配置中不得填写 Token |
| `toolCallTimeoutMs` | `60000` | 单次 MCP 工具调用超时 |
| `failOnStartupError` | `false` | 首次连接失败是否阻止插件激活 |
| `reconnect.*` | 见源码默认值 | 网络中断后的有限指数退避 |

登录成功后重启或热重载 DSH。访问令牌过期前，插件会在跨进程文件锁内调用 MCP SDK 刷新并原子回写；多个 DSH 进程共享同一凭据文件时不会并发重放旧 Refresh Token。Refresh Token 失效时，插件撤销工具并提示重新运行 `login`。

## 当前允许的能力

- Schema、只读查询、API 搜索和 Bytebase 内置技能说明。
- 创建数据库变更工单，但不能同时创建 Rollout。
- 读取工单、计划检查、Rollout 和 TaskRun 状态。
- 经 DSH approval 后，为已批准计划创建 Rollout、运行指定任务。

实现与验证边界见 [实施规格](docs/spec/bytebase-mcp-oauth.md) 和 [验收记录](docs/acceptance/bytebase-mcp-oauth/)。

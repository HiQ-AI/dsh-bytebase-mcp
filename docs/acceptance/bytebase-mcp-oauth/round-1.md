# Round 1 验收记录

## 结论

源码、Windows 凭据保护、本地 OAuth/MCP 协议、DSH 写操作门禁、构建打包和 Bytebase 在线公开端点均通过。真实 Bytebase OAuth 登录需要用户本人确认授权，真实数据库变更会创建外部业务状态，本轮均未执行，不能视为业务 E2E 已完成。

## 自动化证据

执行：

```powershell
npm run check
```

结果：

- TypeScript 严格类型检查通过。
- Vitest 共 6 个测试文件、20 项测试全部通过。
- 测试包含 Windows CurrentUser DPAPI 真实加解密往返。
- 本地协议 fixture 完成 OAuth 动态注册、Authorization Code + PKCE、回调 state 校验、Token 持久化、过期刷新和 MCP 工具发现。
- 两个并发刷新者只有一个实际使用旧 Refresh Token，等待者回读新 Token。
- 真实 DSH ToolRuntime 在 approval 服务缺失时于 MCP 请求前拒绝写操作。
- 构建通过；`npm pack --dry-run` 得到 44 个文件、29.9 kB 压缩包、119.1 kB 解包大小。
- `dsh --profile web --patch .\cordis.patch.yml --dump-config` 成功，合成配置中出现 `bytebase-mcp` 插件及预期 URL；该命令只读，没有安装或重启生产 profile。

## 在线只读证据

执行：

```powershell
node lib/bin.js doctor
node lib/bin.js status
```

结果：

- Node `v24.19.0`，平台 `win32`。
- `/.well-known/oauth-protected-resource/mcp` 返回 200，resource 与 authorization server 均为 `https://bytebase.hiqdat.dev`。
- `/.well-known/oauth-authorization-server` 返回 200，声明 Authorization Code、Refresh Token、动态客户端注册和 PKCE S256。
- 未认证访问 `/mcp` 返回 401，符合受保护资源预期。
- 本机状态为 `signedIn: false`，本轮没有创建真实 Bytebase OAuth 凭据。

## 未完成边界

- `dsh-bytebase-mcp login`：需用户本人在浏览器确认 Bytebase OAuth，未代替用户执行。
- 真实建工单、创建 Rollout、运行 Task：会改变 Bytebase 业务状态，未执行。
- `npm audit --omit=dev`：配置镜像返回 504，切换官方 registry 后在本轮等待窗口内无结果；供应链审计状态未收敛。锁文件和直接依赖树已生成且 `npm ls --depth=0` 通过，但这不等价于漏洞审计通过。

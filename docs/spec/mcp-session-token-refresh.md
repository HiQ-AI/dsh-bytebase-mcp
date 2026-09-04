# MCP 会话令牌主动刷新

## 问题

Bytebase MCP 长连接会话在建立时绑定 Access Token。OAuth 凭据文件可以由 Refresh Token 更新，但既有 MCP 会话不会因此自动换用新令牌，导致主会话或叶子会话在令牌到期后都收到工具级 HTTP 401。

## 目标

1. 凭据仍由 DSH Runtime 全局共享，不按 Agent 或 Session 保存。
2. 在 Access Token 到期前刷新共享凭据，并主动重建 MCP 会话。
3. 新旧会话切换后重新同步全局工具；刷新失败沿用既有重连边界，不绕过 OAuth。
4. 保留服务端未轮换 Refresh Token 时的原 Refresh Token。

## 方案

- `OAuthCredentialStore.refreshTokensIfNeeded` 接受最小剩余有效期，继续在跨进程文件锁内决定是否真正刷新。
- `BytebaseOAuthProvider` 暴露到期前刷新和下一次会话轮换延迟，但不暴露令牌内容。
- `startConnection` 在每次成功建连后设置一次到期计时器；计时器触发时先刷新共享凭据，再关闭旧连接并建立新连接。
- 计时器属于连接句柄生命周期，断连、重连和 dispose 都会清理，避免重复连接。

## 边界与回滚

不改变工具权限、审批、数据库调用参数或凭据位置。回滚本提交即可恢复仅依赖 MCP SDK 被动认证的行为；生产数据不受此改动直接影响。

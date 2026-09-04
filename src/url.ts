import { DEFAULT_CALLBACK_PORT } from './constants.js'

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
}

export function normalizeServerUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('Bytebase MCP URL 必须是有效的绝对 URL')
  }
  if (url.username !== '' || url.password !== '') throw new Error('Bytebase MCP URL 不得包含用户名或密码')
  if (url.search !== '' || url.hash !== '') throw new Error('Bytebase MCP URL 不得包含查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('Bytebase MCP URL 必须使用 HTTPS；只有 loopback 测试地址可以使用 HTTP')
  }
  if (url.pathname.replace(/\/+$/u, '') !== '/mcp') throw new Error('Bytebase MCP URL 路径必须是 /mcp')
  url.pathname = '/mcp'
  return url.toString()
}

export function callbackUrl(port = DEFAULT_CALLBACK_PORT): string {
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('OAuth 回调端口必须是 1024 到 65535 之间的整数')
  }
  return `http://127.0.0.1:${port}/callback`
}

export function assertAuthorizationUrl(serverUrl: string, candidate: URL): void {
  const server = new URL(normalizeServerUrl(serverUrl))
  if (candidate.username !== '' || candidate.password !== '') throw new Error('OAuth 授权地址不得包含凭据')
  if (candidate.protocol !== 'https:' && !(candidate.protocol === 'http:' && isLoopback(candidate.hostname))) {
    throw new Error('OAuth 授权地址必须使用 HTTPS')
  }
  if (candidate.origin !== server.origin) throw new Error('OAuth 授权地址与 Bytebase MCP 地址不同源，已拒绝打开')
}

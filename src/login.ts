import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthCredentialStore } from './auth-store.js'
import { BytebaseOAuthProvider } from './oauth-provider.js'
import { DEFAULT_LOGIN_TIMEOUT_MS } from './constants.js'
import { callbackUrl, normalizeServerUrl } from './url.js'

export interface LoginOptions {
  store: OAuthCredentialStore
  serverUrl: string
  callbackPort: number
  timeoutMs?: number
  openAuthorization?: (url: URL) => void | Promise<void>
}

export interface LoginResult {
  serverUrl: string
  tools: string[]
}

interface CallbackWaiter {
  server: Server
  promise: Promise<string>
  close(): Promise<void>
}

function html(title: string, message: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${message}</p></body></html>`
}

async function startCallbackServer(
  port: number,
  expectedState: () => string | undefined,
  timeoutMs: number,
): Promise<CallbackWaiter> {
  let settle: ((code: string) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const promise = new Promise<string>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const server = createServer((request, response) => {
    const remote = request.socket.remoteAddress
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Forbidden')
      return
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not Found')
      return
    }
    const error = url.searchParams.get('error')
    if (error !== null) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('Bytebase 授权失败', '请返回终端查看非敏感错误并重新登录。'))
      fail?.(new Error(`Bytebase OAuth 返回错误：${error}`))
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code === null || state === null || state !== expectedState()) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('无效的 OAuth 回调', 'state 或授权码不匹配，本次请求已拒绝。'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html('Bytebase 授权已接收', '可以关闭此页面，返回 DSH。'))
    settle?.(code)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const timer = setTimeout(() => fail?.(new Error('等待 Bytebase OAuth 回调超时')), timeoutMs)
  timer.unref()
  return {
    server,
    promise,
    async close() {
      clearTimeout(timer)
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    },
  }
}

export async function openSystemBrowser(url: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url.toString()], {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const serverUrl = normalizeServerUrl(options.serverUrl)
  const redirectUrl = callbackUrl(options.callbackPort)
  await options.store.prepareLogin(serverUrl, redirectUrl)
  let provider: BytebaseOAuthProvider
  let authorizationUrl: URL | undefined
  provider = await BytebaseOAuthProvider.create({
    store: options.store,
    serverUrl,
    redirectUrl,
    async onAuthorization(url) {
      authorizationUrl = url
      process.stdout.write(`请在浏览器完成 Bytebase 授权：\n${url.toString()}\n`)
      await (options.openAuthorization ?? openSystemBrowser)(url)
    },
  })
  const waiter = await startCallbackServer(
    options.callbackPort,
    () => provider.expectedState(),
    options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
  )
  const firstClient = new Client({ name: 'dsh-bytebase-mcp-login', version: '0.1.0' }, { capabilities: {} })
  const firstTransport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider })
  try {
    try {
      await firstClient.connect(firstTransport as Transport)
    } catch (error: unknown) {
      if (!(error instanceof UnauthorizedError)) throw error
      if (authorizationUrl === undefined) throw new Error('Bytebase MCP 要求授权，但没有返回 OAuth 授权地址')
      const code = await waiter.promise
      await firstTransport.finishAuth(code)
    }
  } finally {
    await waiter.close()
    try { await firstClient.close() } catch {}
  }

  const verifyClient = new Client({ name: 'dsh-bytebase-mcp-login-verify', version: '0.1.0' }, { capabilities: {} })
  const verifyTransport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider })
  try {
    await verifyClient.connect(verifyTransport as Transport)
    const tools = await verifyClient.listTools()
    return { serverUrl, tools: tools.tools.map(tool => tool.name).sort() }
  } finally {
    try { await verifyClient.close() } catch {}
  }
}

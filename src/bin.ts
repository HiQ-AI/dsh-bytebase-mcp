#!/usr/bin/env node
import { resolve } from 'node:path'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { OAuthCredentialStore } from './auth-store.js'
import { WindowsDpapiProtector } from './dpapi.js'
import {
  AUTH_FILENAME,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_SERVER_URL,
  PACKAGE_NAME,
} from './constants.js'
import { login } from './login.js'
import { normalizeServerUrl } from './url.js'

interface CliOptions {
  command: string
  url: string
  credentialPath: string
  callbackPort: number
  openBrowser: boolean
}

function usage(): string {
  return [
    '用法: dsh-bytebase-mcp <login|status|doctor|logout> [options]',
    '',
    `  --url <url>                 Bytebase MCP URL（默认 ${DEFAULT_SERVER_URL}）`,
    `  --credential-path <path>    DPAPI 凭据文件（默认 $DSH_HOME/${AUTH_FILENAME}）`,
    `  --callback-port <port>      OAuth loopback 端口（默认 ${DEFAULT_CALLBACK_PORT}）`,
    '  --no-open                   不自动打开浏览器，只打印授权 URL',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] ?? 'help'
  let url = DEFAULT_SERVER_URL
  let credentialPath = dshHomePath(AUTH_FILENAME)
  let callbackPort = DEFAULT_CALLBACK_PORT
  let openBrowser = true
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--no-open') {
      openBrowser = false
      continue
    }
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${arg} 缺少参数值`)
    if (arg === '--url') url = value
    else if (arg === '--credential-path') credentialPath = resolve(expandHomePath(value))
    else if (arg === '--callback-port') callbackPort = Number(value)
    else throw new Error(`未知参数：${arg}`)
    index += 1
  }
  return { command, url: normalizeServerUrl(url), credentialPath, callbackPort, openBrowser }
}

async function doctor(serverUrl: string): Promise<Record<string, unknown>> {
  const endpoint = new URL(serverUrl)
  const origin = endpoint.origin
  const checks: Record<string, unknown> = {
    package: PACKAGE_NAME,
    node: process.version,
    platform: process.platform,
    mcpUrl: serverUrl,
  }
  for (const [name, url] of [
    ['protectedResource', `${origin}/.well-known/oauth-protected-resource/mcp`],
    ['authorizationServer', `${origin}/.well-known/oauth-authorization-server`],
  ] as const) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      checks[name] = { ok: response.ok, status: response.status }
      await response.body?.cancel()
    } catch (error: unknown) {
      checks[name] = { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }
    }
  }
  return checks
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help' || options.command === '--help' || options.command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (process.platform !== 'win32') throw new Error('本插件当前只支持 Windows CurrentUser DPAPI')
  const store = new OAuthCredentialStore(options.credentialPath, new WindowsDpapiProtector())
  if (options.command === 'status') {
    process.stdout.write(`${JSON.stringify(await store.status(), null, 2)}\n`)
    return
  }
  if (options.command === 'doctor') {
    process.stdout.write(`${JSON.stringify(await doctor(options.url), null, 2)}\n`)
    return
  }
  if (options.command === 'logout') {
    const removed = await store.remove()
    process.stdout.write(`${removed ? 'Bytebase MCP OAuth 凭据已删除。' : '没有找到 Bytebase MCP OAuth 凭据。'}\n`)
    return
  }
  if (options.command === 'login') {
    const result = await login({
      store,
      serverUrl: options.url,
      callbackPort: options.callbackPort,
      ...(options.openBrowser ? {} : { openAuthorization: () => undefined }),
    })
    process.stdout.write(`Bytebase MCP 登录成功；发现 ${result.tools.length} 个服务器工具。请重启或热重载 DSH。\n`)
    return
  }
  throw new Error(`未知命令：${options.command}\n\n${usage()}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-bytebase-mcp: ${message.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')}\n`)
  process.exitCode = 1
})

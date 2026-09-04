import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { OAuthCredentialStore } from './auth-store.js'
import { WindowsDpapiProtector } from './dpapi.js'
import { BytebaseOAuthProvider } from './oauth-provider.js'
import {
  DEFAULT_SERVER_URL,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  PLUGIN_NAME,
} from './constants.js'
import {
  RECONNECT_DEFAULTS,
  resolveReconnectPolicy,
  startConnection,
  type ReconnectConfig,
} from './connection.js'
import { callbackUrl, normalizeServerUrl } from './url.js'

export const name = PLUGIN_NAME
export const inject = ['tools']

export interface Config {
  url: string
  credentialPath: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect?: ReconnectConfig
}

type ConfigInput = Partial<Config>

const Reconnect = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).default(RECONNECT_DEFAULTS.maxAttempts),
})

export const Config = z.object({
  url: z.string().default(DEFAULT_SERVER_URL),
  credentialPath: z.string().default(''),
  toolCallTimeoutMs: z.number().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
}) as unknown as z<ConfigInput, Config>

export function resolveCredentialPath(configured: string): string {
  return configured.trim() === '' ? dshHomePath('.bytebase-mcp-auth.json') : resolve(expandHomePath(configured))
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'win32') throw new Error('bytebase-mcp 当前使用 Windows DPAPI，仅支持 Windows')
  const url = normalizeServerUrl(config.url)
  const store = new OAuthCredentialStore(resolveCredentialPath(config.credentialPath), new WindowsDpapiProtector())
  const state = await store.read(url)
  if (state?.tokens === undefined) {
    const message = 'bytebase-mcp: 尚未登录；请运行 dsh-bytebase-mcp login，完成后重启或热重载 DSH'
    if (config.failOnStartupError) throw new Error(message)
    ctx.logger.warn(message)
    return
  }
  const provider = await BytebaseOAuthProvider.create({
    store,
    serverUrl: url,
    redirectUrl: state.redirectUrl ?? callbackUrl(),
  })
  const connection = startConnection(ctx, {
    url,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
  }, provider, resolveReconnectPolicy(config.reconnect))
  ctx.effect(() => () => connection.dispose(), 'bytebase-mcp.connection')
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error('bytebase-mcp: initial connection or tool synchronization failed', { cause: outcome.error })
  }
}

export { OAuthCredentialStore } from './auth-store.js'
export { WindowsDpapiProtector } from './dpapi.js'
export { BytebaseOAuthProvider, InteractiveLoginRequiredError } from './oauth-provider.js'
export { publicToolName } from './tools.js'
export { normalizeServerUrl } from './url.js'

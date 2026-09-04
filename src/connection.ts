import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Context } from '@deepseek-ai/cordis'
import type { BytebaseOAuthProvider } from './oauth-provider.js'
import { InteractiveLoginRequiredError } from './oauth-provider.js'
import { SERVER_NAME } from './constants.js'
import { syncTools, type ToolDisposers } from './tools.js'

export interface ReconnectConfig {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

export interface ResolvedReconnectPolicy {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

export interface ConnectionConfig {
  url: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}

export interface ConnectionHandle {
  ready: Promise<{ error?: unknown }>
  dispose(): Promise<void>
}

export const RECONNECT_DEFAULTS: Readonly<ResolvedReconnectPolicy> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

export function resolveReconnectPolicy(config?: ReconnectConfig): ResolvedReconnectPolicy {
  const policy = { ...RECONNECT_DEFAULTS, ...config }
  if (!Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs <= 0) throw new Error('reconnect.initialDelayMs 必须是正数')
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs <= 0) throw new Error('reconnect.maxDelayMs 必须是正数')
  if (policy.initialDelayMs > policy.maxDelayMs) throw new Error('reconnect.initialDelayMs 不能大于 reconnect.maxDelayMs')
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new Error('reconnect.maxAttempts 必须是正整数')
  return policy
}

function loginRequired(error: unknown): boolean {
  if (error instanceof InteractiveLoginRequiredError) return true
  if (error instanceof Error && error.cause !== undefined) return loginRequired(error.cause)
  return false
}

export function startConnection(
  ctx: Context,
  config: ConnectionConfig,
  provider: BytebaseOAuthProvider,
  policy: ResolvedReconnectPolicy,
): ConnectionHandle {
  let disposed = false
  let client: Client | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let failedAttempts = 0
  let connectedAt: number | undefined
  let firstAttemptError: unknown
  let disposers: ToolDisposers = new Map()
  let syncChain = Promise.resolve()
  let settling: Promise<void>

  const clearTools = (): void => {
    for (const dispose of disposers.values()) dispose()
    disposers = new Map()
  }

  const scheduleReconnect = (error: unknown): void => {
    if (disposed) return
    if (loginRequired(error)) {
      clearTools()
      ctx.logger.error(`bytebase-mcp: ${String(error)}`)
      return
    }
    if (!policy.enabled) {
      ctx.logger.error('bytebase-mcp: connection lost and reconnect is disabled')
      return
    }
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      clearTools()
      ctx.logger.error(`bytebase-mcp: giving up after ${policy.maxAttempts} reconnect attempts; tools unregistered`)
      return
    }
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    ctx.logger.warn(`bytebase-mcp: reconnecting in ${delay}ms (${failedAttempts}/${policy.maxAttempts})`)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      settling = connectOnce(false)
    }, delay)
    retryTimer.unref()
  }

  const connectOnce = async (startup: boolean): Promise<void> => {
    const generation = new Client({ name: 'dsh-bytebase-mcp', version: '0.1.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { authProvider: provider })
    let closing = false
    client = generation
    generation.onclose = () => {
      if (disposed || closing || client !== generation) return
      client = undefined
      scheduleReconnect(new Error('MCP transport closed'))
    }
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (disposed || client !== generation) return
      const run = syncChain.then(async () => {
        if (!disposed && client === generation) {
          disposers = await syncTools(generation, ctx, {
            serverName: SERVER_NAME,
            toolCallTimeoutMs: config.toolCallTimeoutMs,
            registrationFailure: 'contain',
          }, disposers)
        }
      })
      syncChain = run.catch(() => undefined)
      await run
    })
    try {
      await generation.connect(transport as Transport)
      const run = syncChain.then(async () => {
        if (!disposed && client === generation) {
          disposers = await syncTools(generation, ctx, {
            serverName: SERVER_NAME,
            toolCallTimeoutMs: config.toolCallTimeoutMs,
            registrationFailure: startup && config.failOnStartupError ? 'throw' : 'contain',
          }, disposers)
        }
      })
      syncChain = run.catch(() => undefined)
      await run
      connectedAt = Date.now()
      if (failedAttempts > 0) ctx.logger.info('bytebase-mcp: reconnected and synchronized tools')
    } catch (error: unknown) {
      firstAttemptError ??= error
      closing = true
      if (client === generation) client = undefined
      try { await generation.close() } catch {}
      scheduleReconnect(error)
    }
  }

  settling = connectOnce(true)
  return {
    ready: settling.then(() => client === undefined ? { error: firstAttemptError } : {}),
    async dispose() {
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      const current = client
      client = undefined
      if (current !== undefined) {
        try { await current.close() } catch {}
      }
      await settling
      await syncChain
      clearTools()
    },
  }
}

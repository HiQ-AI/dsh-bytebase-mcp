import { lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { z } from 'zod'
import type { DataProtector } from './dpapi.js'
import { normalizeServerUrl } from './url.js'

const MAX_AUTH_FILE_BYTES = 4 * 1024 * 1024

const JsonRecord = z.record(z.string(), z.unknown())
const ClientInformation = JsonRecord.refine(value => typeof value.client_id === 'string' && value.client_id.length > 0)
const Tokens = JsonRecord.refine(value => (
  typeof value.access_token === 'string'
  && value.access_token.length > 0
  && typeof value.token_type === 'string'
  && value.token_type.length > 0
))
const StoredStateSchema = z.object({
  version: z.literal(1),
  serverUrl: z.string().min(1),
  redirectUrl: z.string().url(),
  clientInformation: ClientInformation.optional(),
  tokens: Tokens.optional(),
  accessExpiresAt: z.string().datetime().optional(),
  discoveryState: JsonRecord.optional(),
  updatedAt: z.string().datetime(),
}).strict()
const EnvelopeSchema = z.object({
  version: z.literal(1),
  protection: z.literal('windows-dpapi-current-user'),
  payload: z.string().min(1),
}).strict()

export interface StoredOAuthState {
  version: 1
  serverUrl: string
  redirectUrl: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  accessExpiresAt?: string
  discoveryState?: OAuthDiscoveryState
  updatedAt: string
}

export interface CredentialStatus {
  signedIn: boolean
  serverUrl?: string
  redirectUrl?: string
  hasRefreshToken?: boolean
  accessExpiresAt?: string
  updatedAt?: string
}

function cloneState(state: StoredOAuthState): StoredOAuthState {
  return structuredClone(state)
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function tokenExpiry(tokens: OAuthTokens, now = Date.now()): string | undefined {
  if (typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    return undefined
  }
  return new Date(now + tokens.expires_in * 1000).toISOString()
}

function tokenIsFresh(state: StoredOAuthState, skewMs = 30_000): boolean {
  if (state.tokens === undefined || state.accessExpiresAt === undefined) return false
  const expiresAt = Date.parse(state.accessExpiresAt)
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + skewMs
}

export class OAuthCredentialStore {
  readonly filename: string

  constructor(filename: string, private readonly protector: DataProtector) {
    this.filename = resolve(filename)
  }

  async read(serverUrl?: string): Promise<StoredOAuthState | undefined> {
    const state = await this.readUnlocked()
    if (state === undefined || serverUrl === undefined) return state
    const expected = normalizeServerUrl(serverUrl)
    if (state.serverUrl !== expected) {
      throw new Error('已保存的 OAuth 凭据绑定到另一个 Bytebase MCP 地址；请先 logout 再重新 login')
    }
    return state
  }

  async update(
    serverUrl: string,
    redirectUrl: string,
    updater: (current: StoredOAuthState) => StoredOAuthState,
  ): Promise<StoredOAuthState> {
    const normalized = normalizeServerUrl(serverUrl)
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return await withFileLock(this.filename, async () => {
      const existing = await this.readUnlocked()
      if (existing !== undefined && existing.serverUrl !== normalized) {
        throw new Error('拒绝用其他 Bytebase MCP 地址覆盖现有 OAuth 凭据；请先 logout')
      }
      const base: StoredOAuthState = existing ?? {
        version: 1,
        serverUrl: normalized,
        redirectUrl,
        updatedAt: new Date().toISOString(),
      }
      const next = updater(cloneState(base))
      const validated = this.validateState({
        ...next,
        version: 1,
        serverUrl: normalized,
        redirectUrl,
        updatedAt: new Date().toISOString(),
      })
      return await this.writeUnlocked(validated)
    }, { waitMs: 30_000 })
  }

  async refreshTokensIfNeeded(
    serverUrl: string,
    redirectUrl: string,
    refresher: (current: StoredOAuthState) => Promise<OAuthTokens>,
  ): Promise<StoredOAuthState | undefined> {
    const normalized = normalizeServerUrl(serverUrl)
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return await withFileLock(this.filename, async () => {
      const existing = await this.readUnlocked()
      if (existing === undefined) return undefined
      if (existing.serverUrl !== normalized || existing.redirectUrl !== redirectUrl) {
        throw new Error('OAuth 凭据与当前 Bytebase MCP 或回调地址不匹配；请重新 login')
      }
      if (existing.tokens === undefined || existing.tokens.refresh_token === undefined || tokenIsFresh(existing)) {
        return cloneState(existing)
      }
      const tokens = await refresher(cloneState(existing))
      const next = cloneState(existing)
      next.tokens = structuredClone(tokens)
      const expiresAt = tokenExpiry(tokens)
      if (expiresAt === undefined) delete next.accessExpiresAt
      else next.accessExpiresAt = expiresAt
      next.updatedAt = new Date().toISOString()
      return await this.writeUnlocked(this.validateState(next))
    }, { waitMs: 60_000 })
  }

  async prepareLogin(serverUrl: string, redirectUrl: string): Promise<StoredOAuthState> {
    const normalized = normalizeServerUrl(serverUrl)
    const existing = await this.read()
    if (existing !== undefined && existing.serverUrl !== normalized) {
      throw new Error('现有凭据属于另一个 Bytebase MCP 地址；请先 logout')
    }
    const redirectChanged = existing !== undefined && existing.redirectUrl !== redirectUrl
    return await this.update(normalized, redirectUrl, current => {
      delete current.tokens
      delete current.accessExpiresAt
      if (redirectChanged) delete current.clientInformation
      return current
    })
  }

  async remove(): Promise<boolean> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return await withFileLock(this.filename, async () => {
      try {
        const info = await lstat(this.filename)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('OAuth 凭据路径不是普通文件，拒绝删除')
        await unlink(this.filename)
        return true
      } catch (error: unknown) {
        if (isNotFound(error)) return false
        throw error
      }
    }, { waitMs: 30_000 })
  }

  async status(): Promise<CredentialStatus> {
    const state = await this.read()
    if (state === undefined) return { signedIn: false }
    return {
      signedIn: state.tokens !== undefined,
      serverUrl: state.serverUrl,
      redirectUrl: state.redirectUrl,
      hasRefreshToken: typeof state.tokens?.refresh_token === 'string' && state.tokens.refresh_token.length > 0,
      ...(state.accessExpiresAt === undefined ? {} : { accessExpiresAt: state.accessExpiresAt }),
      updatedAt: state.updatedAt,
    }
  }

  private validateState(input: unknown): StoredOAuthState {
    const parsed = StoredStateSchema.safeParse(input)
    if (!parsed.success) throw new Error('OAuth 凭据状态格式无效')
    const state = parsed.data as unknown as StoredOAuthState
    state.serverUrl = normalizeServerUrl(state.serverUrl)
    return state
  }

  private async writeUnlocked(state: StoredOAuthState): Promise<StoredOAuthState> {
    const payload = await this.protector.protect(JSON.stringify(state))
    const envelope = JSON.stringify({
      version: 1,
      protection: 'windows-dpapi-current-user',
      payload,
    }, null, 2) + '\n'
    await writeFileAtomic(this.filename, envelope, { mode: 0o600, dirMode: 0o700 })
    return cloneState(state)
  }

  private async readUnlocked(): Promise<StoredOAuthState | undefined> {
    let info
    try {
      info = await lstat(this.filename)
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('OAuth 凭据路径必须是非符号链接的普通文件')
    if (info.size > MAX_AUTH_FILE_BYTES) throw new Error('OAuth 凭据文件超过安全大小上限')
    let envelope: z.infer<typeof EnvelopeSchema>
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(await readFile(this.filename, 'utf8')))
    } catch {
      throw new Error('OAuth 凭据文件格式无效')
    }
    try {
      const plaintext = await this.protector.unprotect(envelope.payload)
      return this.validateState(JSON.parse(plaintext))
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Windows DPAPI')) throw error
      throw new Error('OAuth 凭据无法由当前 Windows 用户解密或内容无效')
    }
  }
}

import { randomBytes } from 'node:crypto'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthCredentialStore, StoredOAuthState } from './auth-store.js'
import { assertAuthorizationUrl, normalizeServerUrl } from './url.js'

export class InteractiveLoginRequiredError extends Error {
  constructor() {
    super('Bytebase OAuth 需要重新登录；请运行 dsh-bytebase-mcp login，然后重启或热重载 DSH')
    this.name = 'InteractiveLoginRequiredError'
  }
}

export interface BytebaseOAuthProviderOptions {
  store: OAuthCredentialStore
  serverUrl: string
  redirectUrl: string
  onAuthorization?: (url: URL) => void | Promise<void>
}

const OAUTH_REQUEST_TIMEOUT_MS = 30_000

async function oauthFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS)
  const signal = init?.signal === undefined || init.signal === null
    ? timeout
    : AbortSignal.any([init.signal, timeout])
  return await fetch(input, { ...init, signal })
}

function withoutRefreshToken(tokens: OAuthTokens): OAuthTokens {
  const copy = structuredClone(tokens)
  delete copy.refresh_token
  return copy
}

export class BytebaseOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string
  readonly clientMetadata: OAuthClientMetadata
  private stateValue: StoredOAuthState
  private verifier: string | undefined
  private expectedStateValue: string | undefined

  private constructor(private readonly options: BytebaseOAuthProviderOptions, initial: StoredOAuthState) {
    this.stateValue = initial
    this.redirectUrl = options.redirectUrl
    this.clientMetadata = {
      client_name: 'DSH Bytebase MCP',
      redirect_uris: [options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  static async create(options: BytebaseOAuthProviderOptions): Promise<BytebaseOAuthProvider> {
    const serverUrl = normalizeServerUrl(options.serverUrl)
    const current = await options.store.read(serverUrl)
    const initial = current ?? {
      version: 1,
      serverUrl,
      redirectUrl: options.redirectUrl,
      updatedAt: new Date().toISOString(),
    }
    if (initial.redirectUrl !== options.redirectUrl && initial.clientInformation !== undefined) {
      throw new Error('OAuth 回调地址与已注册客户端不一致；请重新运行 login')
    }
    return new BytebaseOAuthProvider({ ...options, serverUrl }, initial)
  }

  expectedState(): string | undefined {
    return this.expectedStateValue
  }

  async state(): Promise<string> {
    this.expectedStateValue = randomBytes(32).toString('base64url')
    return this.expectedStateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.stateValue.clientInformation === undefined
      ? undefined
      : structuredClone(this.stateValue.clientInformation)
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.persist(current => {
      current.clientInformation = structuredClone(clientInformation)
      return current
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    try {
      const refreshed = await this.options.store.refreshTokensIfNeeded(
        this.options.serverUrl,
        this.options.redirectUrl,
        async current => {
          const clientInformation = current.clientInformation
          const refreshToken = current.tokens?.refresh_token
          if (clientInformation === undefined || refreshToken === undefined) {
            throw new InteractiveLoginRequiredError()
          }
          const serverInfo = await discoverOAuthServerInfo(this.options.serverUrl, { fetchFn: oauthFetch })
          assertAuthorizationUrl(this.options.serverUrl, new URL(serverInfo.authorizationServerUrl))
          const resource = new URL(
            serverInfo.resourceMetadata?.resource ?? new URL(this.options.serverUrl).origin,
          )
          assertAuthorizationUrl(this.options.serverUrl, resource)
          return await refreshAuthorization(serverInfo.authorizationServerUrl, {
            ...(serverInfo.authorizationServerMetadata === undefined
              ? {}
              : { metadata: serverInfo.authorizationServerMetadata }),
            clientInformation,
            refreshToken,
            resource,
            fetchFn: oauthFetch,
          })
        },
      )
      if (refreshed !== undefined) this.stateValue = refreshed
      return refreshed?.tokens === undefined ? undefined : withoutRefreshToken(refreshed.tokens)
    } catch (error: unknown) {
      if (error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
        await this.invalidateCredentials('tokens')
        throw new InteractiveLoginRequiredError()
      }
      throw error
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.persist(current => {
      current.tokens = structuredClone(tokens)
      if (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0) {
        current.accessExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      } else {
        delete current.accessExpiresAt
      }
      return current
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    assertAuthorizationUrl(this.options.serverUrl, authorizationUrl)
    if (this.options.onAuthorization === undefined) throw new InteractiveLoginRequiredError()
    await this.options.onAuthorization(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error('OAuth PKCE verifier 不存在，请重新登录')
    return this.verifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = undefined
      return
    }
    await this.persist(current => {
      if (scope === 'all' || scope === 'tokens') {
        delete current.tokens
        delete current.accessExpiresAt
      }
      if (scope === 'all' || scope === 'client') delete current.clientInformation
      if (scope === 'all' || scope === 'discovery') delete current.discoveryState
      return current
    })
    if (scope === 'all') this.verifier = undefined
  }

  private async persist(updater: (state: StoredOAuthState) => StoredOAuthState): Promise<void> {
    this.stateValue = await this.options.store.update(
      this.options.serverUrl,
      this.options.redirectUrl,
      updater,
    )
  }
}

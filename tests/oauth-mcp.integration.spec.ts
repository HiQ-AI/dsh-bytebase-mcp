import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Context } from '@deepseek-ai/cordis'
import { OAuthCredentialStore } from '../src/auth-store.js'
import type { DataProtector } from '../src/dpapi.js'
import { RECONNECT_DEFAULTS, startConnection } from '../src/connection.js'
import { login } from '../src/login.js'
import { BytebaseOAuthProvider } from '../src/oauth-provider.js'

class FixtureProtector implements DataProtector {
  async protect(value: string): Promise<string> { return Buffer.from(value).toString('base64') }
  async unprotect(value: string): Promise<string> { return Buffer.from(value, 'base64').toString() }
}

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(value))
}

async function startFixture() {
  let origin = ''
  let validAccessToken = 'access-1'
  let codeExchangeCount = 0
  let refreshCount = 0
  let initializeCount = 0
  const tools = [
    'search_api',
    'get_skill',
    'get_schema',
    'query_database',
    'propose_database_change',
    'call_api',
  ]
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(response, 200, { resource: origin, authorization_servers: [origin], bearer_methods_supported: ['header'] })
      return
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/api/oauth2/authorize`,
        token_endpoint: `${origin}/api/oauth2/token`,
        registration_endpoint: `${origin}/api/oauth2/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (url.pathname === '/api/oauth2/register' && request.method === 'POST') {
      const metadata = JSON.parse(await body(request)) as Record<string, unknown>
      json(response, 201, { ...metadata, client_id: 'fixture-client' })
      return
    }
    if (url.pathname === '/api/oauth2/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      redirect.searchParams.set('code', 'fixture-code')
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
      response.writeHead(302, { location: redirect.toString() })
      response.end()
      return
    }
    if (url.pathname === '/api/oauth2/token' && request.method === 'POST') {
      const form = new URLSearchParams(await body(request))
      if (form.get('grant_type') === 'authorization_code') {
        codeExchangeCount += 1
        json(response, 200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
        })
        return
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1') {
        refreshCount += 1
        json(response, 200, {
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          token_type: 'Bearer',
          expires_in: 3600,
        })
        return
      }
      json(response, 400, { error: 'invalid_grant' })
      return
    }
    if (url.pathname === '/mcp') {
      const auth = request.headers.authorization
      if (auth !== `Bearer ${validAccessToken}`) {
        json(response, 401, { error: 'unauthorized' }, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        return
      }
      if (request.method === 'GET') {
        response.writeHead(405)
        response.end()
        return
      }
      const message = JSON.parse(await body(request)) as { jsonrpc: '2.0'; id?: number; method: string; params?: Record<string, unknown> }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202)
        response.end()
        return
      }
      if (message.method === 'initialize') {
        initializeCount += 1
        json(response, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'bytebase-fixture', version: '1.0.0' },
          },
        })
        return
      }
      if (message.method === 'tools/list') {
        json(response, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: tools.map(name => ({ name, description: name, inputSchema: { type: 'object' } })) },
        })
        return
      }
      json(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'ok' }] },
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
  origin = `http://127.0.0.1:${address.port}`
  closers.push(async () => await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
  return {
    serverUrl: `${origin}/mcp`,
    get codeExchangeCount() { return codeExchangeCount },
    get refreshCount() { return refreshCount },
    get initializeCount() { return initializeCount },
    requireRefreshedToken() { validAccessToken = 'access-2' },
  }
}

describe('OAuth + MCP integration', () => {
  it('completes PKCE login, persists tokens, then refreshes after a 401', async () => {
    const fixture = await startFixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-bytebase-integration-'))
    roots.push(root)
    const store = new OAuthCredentialStore(join(root, 'auth.json'), new FixtureProtector())
    const result = await login({
      store,
      serverUrl: fixture.serverUrl,
      callbackPort: 14_900 + Math.floor(Math.random() * 500),
      openAuthorization: async url => {
        const response = await fetch(url, { redirect: 'follow' })
        await response.body?.cancel()
      },
    })
    expect(result.tools).toContain('propose_database_change')
    expect(fixture.codeExchangeCount).toBe(1)
    expect((await store.read(fixture.serverUrl))?.tokens?.refresh_token).toBe('refresh-1')

    fixture.requireRefreshedToken()
    const loginState = await store.read(fixture.serverUrl)
    if (loginState === undefined) throw new Error('stored state missing after login')
    await store.update(fixture.serverUrl, loginState.redirectUrl, current => ({
      ...current,
      accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    const state = await store.read(fixture.serverUrl)
    if (state === undefined) throw new Error('stored state missing')
    const provider = await BytebaseOAuthProvider.create({
      store,
      serverUrl: fixture.serverUrl,
      redirectUrl: state.redirectUrl,
    })
    const client = new Client({ name: 'refresh-test', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(fixture.serverUrl), { authProvider: provider })
    try {
      await client.connect(transport as Transport)
      expect((await client.listTools()).tools).toHaveLength(6)
    } finally {
      await client.close()
    }
    expect(fixture.refreshCount).toBe(1)
    expect((await store.read(fixture.serverUrl))?.tokens?.access_token).toBe('access-2')
    expect((await store.read(fixture.serverUrl))?.tokens?.refresh_token).toBe('refresh-2')
  })

  it('refreshes shared credentials and rebuilds the MCP session before token expiry', async () => {
    const fixture = await startFixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-bytebase-session-refresh-'))
    roots.push(root)
    const store = new OAuthCredentialStore(join(root, 'auth.json'), new FixtureProtector())
    await login({
      store,
      serverUrl: fixture.serverUrl,
      callbackPort: 14_900 + Math.floor(Math.random() * 500),
      openAuthorization: async url => {
        const response = await fetch(url, { redirect: 'follow' })
        await response.body?.cancel()
      },
    })
    const loginState = await store.read(fixture.serverUrl)
    if (loginState === undefined) throw new Error('stored state missing after login')
    await store.update(fixture.serverUrl, loginState.redirectUrl, current => ({
      ...current,
      accessExpiresAt: new Date(Date.now() + 31_000).toISOString(),
    }))
    const state = await store.read(fixture.serverUrl)
    if (state === undefined) throw new Error('stored state missing')
    const provider = await BytebaseOAuthProvider.create({
      store,
      serverUrl: fixture.serverUrl,
      redirectUrl: state.redirectUrl,
    })
    const registered = new Set<string>()
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      tools: {
        register(definition: { name: string }) {
          registered.add(definition.name)
          return () => { registered.delete(definition.name) }
        },
      },
    } as unknown as Context
    const connection = startConnection(ctx, {
      url: fixture.serverUrl,
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      sessionRefreshSkewMs: 30_500,
    }, provider, RECONNECT_DEFAULTS)
    try {
      expect(await connection.ready).toEqual({})
      expect(fixture.refreshCount).toBe(0)
      expect(fixture.initializeCount).toBe(2)
      fixture.requireRefreshedToken()

      await expect.poll(() => fixture.refreshCount, { timeout: 5_000 }).toBe(1)
      await expect.poll(() => fixture.initializeCount, { timeout: 5_000 }).toBe(3)
      expect(registered.size).toBe(6)
      expect((await store.read(fixture.serverUrl))?.tokens?.access_token).toBe('access-2')
    } finally {
      await connection.dispose()
    }
  })
})

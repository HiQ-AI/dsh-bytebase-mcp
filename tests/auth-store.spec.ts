import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { OAuthCredentialStore } from '../src/auth-store.js'
import type { DataProtector } from '../src/dpapi.js'

class FixtureProtector implements DataProtector {
  async protect(plaintext: string): Promise<string> {
    return Buffer.from(`fixture:${plaintext}`, 'utf8').toString('base64')
  }

  async unprotect(ciphertext: string): Promise<string> {
    const decoded = Buffer.from(ciphertext, 'base64').toString('utf8')
    if (!decoded.startsWith('fixture:')) throw new Error('bad fixture ciphertext')
    return decoded.slice('fixture:'.length)
  }
}

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function createStore(): Promise<{ store: OAuthCredentialStore; filename: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bytebase-mcp-'))
  roots.push(root)
  const filename = join(root, 'auth.json')
  return { store: new OAuthCredentialStore(filename, new FixtureProtector()), filename }
}

describe('OAuthCredentialStore', () => {
  it('atomically stores an encrypted envelope without plaintext tokens', async () => {
    const { store, filename } = await createStore()
    await store.prepareLogin('https://bytebase.example.com/mcp', 'http://127.0.0.1:14801/callback')
    await store.update('https://bytebase.example.com/mcp', 'http://127.0.0.1:14801/callback', current => ({
      ...current,
      tokens: {
        access_token: 'secret-access-token',
        refresh_token: 'secret-refresh-token',
        token_type: 'Bearer',
      },
    }))

    const raw = await readFile(filename, 'utf8')
    expect(raw).toContain('windows-dpapi-current-user')
    expect(raw).not.toContain('secret-access-token')
    expect(raw).not.toContain('secret-refresh-token')
    expect((await store.read('https://bytebase.example.com/mcp'))?.tokens?.access_token).toBe('secret-access-token')
  })

  it('refuses to reuse credentials for another MCP URL', async () => {
    const { store } = await createStore()
    await store.prepareLogin('https://bytebase.example.com/mcp', 'http://127.0.0.1:14801/callback')
    await expect(store.read('https://other.example.com/mcp')).rejects.toThrow(/另一个/u)
    await expect(store.prepareLogin('https://other.example.com/mcp', 'http://127.0.0.1:14801/callback')).rejects.toThrow(/先 logout/u)
  })

  it('drops registered client information when the callback address changes', async () => {
    const { store } = await createStore()
    await store.prepareLogin('https://bytebase.example.com/mcp', 'http://127.0.0.1:14801/callback')
    await store.update('https://bytebase.example.com/mcp', 'http://127.0.0.1:14801/callback', current => ({
      ...current,
      clientInformation: { client_id: 'client-1' },
      tokens: { access_token: 'access-1', token_type: 'Bearer' },
    }))
    const state = await store.prepareLogin('https://bytebase.example.com/mcp', 'http://127.0.0.1:14802/callback')
    expect(state.clientInformation).toBeUndefined()
    expect(state.tokens).toBeUndefined()
  })

  it('reports only non-sensitive login metadata and removes only its file', async () => {
    const { store } = await createStore()
    expect(await store.status()).toEqual({ signedIn: false })
    await store.prepareLogin('https://bytebase.example.com/mcp', 'http://127.0.0.1:14801/callback')
    await store.update('https://bytebase.example.com/mcp', 'http://127.0.0.1:14801/callback', current => ({
      ...current,
      tokens: { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer' },
    }))
    const status = await store.status()
    expect(status).toMatchObject({
      signedIn: true,
      serverUrl: 'https://bytebase.example.com/mcp',
      hasRefreshToken: true,
    })
    expect(JSON.stringify(status)).not.toContain('access')
    expect(JSON.stringify(status)).not.toContain('refresh"')
    expect(await store.remove()).toBe(true)
    expect(await store.remove()).toBe(false)
  })

  it('serializes refresh and reuses the token written by the first process', async () => {
    const { store } = await createStore()
    const serverUrl = 'https://bytebase.example.com/mcp'
    const redirectUrl = 'http://127.0.0.1:14801/callback'
    await store.prepareLogin(serverUrl, redirectUrl)
    await store.update(serverUrl, redirectUrl, current => ({
      ...current,
      clientInformation: { client_id: 'client-1' },
      tokens: {
        access_token: 'expired-access',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
      },
      accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    let calls = 0
    const refresher = async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 30))
      return {
        access_token: 'fresh-access',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      }
    }
    const [first, second] = await Promise.all([
      store.refreshTokensIfNeeded(serverUrl, redirectUrl, refresher),
      store.refreshTokensIfNeeded(serverUrl, redirectUrl, refresher),
    ])
    expect(calls).toBe(1)
    expect(first?.tokens?.access_token).toBe('fresh-access')
    expect(second?.tokens?.access_token).toBe('fresh-access')
  })
})

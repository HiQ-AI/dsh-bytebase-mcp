import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthCredentialStore } from '../src/auth-store.js'
import type { DataProtector } from '../src/dpapi.js'
import { BytebaseOAuthProvider, InteractiveLoginRequiredError } from '../src/oauth-provider.js'

class FixtureProtector implements DataProtector {
  async protect(value: string): Promise<string> { return Buffer.from(value).toString('base64') }
  async unprotect(value: string): Promise<string> { return Buffer.from(value, 'base64').toString() }
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bytebase-provider-'))
  roots.push(root)
  const store = new OAuthCredentialStore(join(root, 'auth.json'), new FixtureProtector())
  const serverUrl = 'https://bytebase.example.com/mcp'
  const redirectUrl = 'http://127.0.0.1:14801/callback'
  await store.prepareLogin(serverUrl, redirectUrl)
  return { store, serverUrl, redirectUrl }
}

describe('BytebaseOAuthProvider', () => {
  it('persists client information and tokens', async () => {
    const data = await fixture()
    const provider = await BytebaseOAuthProvider.create(data)
    await provider.saveClientInformation({ client_id: 'client-1' })
    await provider.saveTokens({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 3600,
    })
    const restored = await BytebaseOAuthProvider.create(data)
    expect(restored.clientInformation()?.client_id).toBe('client-1')
    expect((await restored.tokens())?.access_token).toBe('access-1')
    expect((await restored.tokens())?.refresh_token).toBeUndefined()
    expect((await data.store.read(data.serverUrl))?.tokens?.refresh_token).toBe('refresh-1')
  })

  it('creates state and refuses background interactive authorization', async () => {
    const data = await fixture()
    const provider = await BytebaseOAuthProvider.create(data)
    const state = await provider.state()
    expect(state).toHaveLength(43)
    expect(provider.expectedState()).toBe(state)
    await expect(provider.redirectToAuthorization(new URL('https://bytebase.example.com/api/oauth2/authorize')))
      .rejects.toBeInstanceOf(InteractiveLoginRequiredError)
  })

  it('opens only same-origin authorization URLs', async () => {
    const data = await fixture()
    const redirect = vi.fn()
    const provider = await BytebaseOAuthProvider.create({ ...data, onAuthorization: redirect })
    await provider.redirectToAuthorization(new URL('https://bytebase.example.com/api/oauth2/authorize'))
    expect(redirect).toHaveBeenCalledOnce()
    await expect(provider.redirectToAuthorization(new URL('https://evil.example.com/authorize'))).rejects.toThrow(/不同源/u)
  })
})

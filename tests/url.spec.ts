import { describe, expect, it } from 'vitest'
import { assertAuthorizationUrl, callbackUrl, normalizeServerUrl } from '../src/url.js'

describe('Bytebase URL policy', () => {
  it('normalizes the production MCP endpoint', () => {
    expect(normalizeServerUrl('https://bytebase.hiqdat.dev/mcp/')).toBe('https://bytebase.hiqdat.dev/mcp')
  })

  it('allows HTTP only for loopback fixtures', () => {
    expect(normalizeServerUrl('http://127.0.0.1:9000/mcp')).toBe('http://127.0.0.1:9000/mcp')
    expect(() => normalizeServerUrl('http://bytebase.example.com/mcp')).toThrow(/HTTPS/u)
  })

  it('rejects credentials, alternate paths and query strings', () => {
    expect(() => normalizeServerUrl('https://user:pass@bytebase.example.com/mcp')).toThrow(/用户名或密码/u)
    expect(() => normalizeServerUrl('https://bytebase.example.com/api')).toThrow(/\/mcp/u)
    expect(() => normalizeServerUrl('https://bytebase.example.com/mcp?token=x')).toThrow(/查询参数/u)
  })

  it('binds authorization redirects to the Bytebase origin', () => {
    expect(() => assertAuthorizationUrl(
      'https://bytebase.example.com/mcp',
      new URL('https://bytebase.example.com/api/oauth2/authorize'),
    )).not.toThrow()
    expect(() => assertAuthorizationUrl(
      'https://bytebase.example.com/mcp',
      new URL('https://evil.example.com/authorize'),
    )).toThrow(/不同源/u)
  })

  it('builds a fixed loopback callback', () => {
    expect(callbackUrl(14_802)).toBe('http://127.0.0.1:14802/callback')
    expect(() => callbackUrl(80)).toThrow(/1024/u)
  })
})

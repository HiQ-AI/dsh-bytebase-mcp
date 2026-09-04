import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WindowsDpapiProtector } from '../src/dpapi.js'

describe('Windows CurrentUser DPAPI', () => {
  it.runIf(process.platform === 'win32')('round-trips a random credential without plaintext ciphertext', async () => {
    const protector = new WindowsDpapiProtector()
    const plaintext = `fixture-${randomBytes(32).toString('hex')}`
    const ciphertext = await protector.protect(plaintext)
    expect(ciphertext).not.toContain(plaintext)
    expect(await protector.unprotect(ciphertext)).toBe(plaintext)
  })
})

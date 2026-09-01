import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { fingerprint, decideHostKey } = require('../electron/host-keys.cjs')

const KEY_A = Buffer.from('ssh-ed25519 AAAA-host-key-a')
const KEY_B = Buffer.from('ssh-ed25519 AAAA-host-key-b')

describe('fingerprint', () => {
  it('is stable for the same key', () => {
    expect(fingerprint(KEY_A)).toBe(fingerprint(KEY_A))
  })

  it('differs for different keys', () => {
    expect(fingerprint(KEY_A)).not.toBe(fingerprint(KEY_B))
  })

  it('is base64 without padding, like the fingerprint OpenSSH prints', () => {
    expect(fingerprint(KEY_A)).toMatch(/^[A-Za-z0-9+/]+$/)
  })
})

describe('decideHostKey', () => {
  it('trusts and records a host it has never seen', () => {
    const d = decideHostKey(undefined, fingerprint(KEY_A))
    expect(d).toMatchObject({ status: 'first-seen', trust: true, remember: true })
  })

  it('trusts a host whose key has not changed', () => {
    const fp = fingerprint(KEY_A)
    expect(decideHostKey(fp, fp)).toMatchObject({ status: 'known', trust: true })
  })

  it('REFUSES a host whose key changed', () => {
    // The regression this exists for. ssh2 auto-accepts when no verifier is
    // set, so before this the substituted key connected silently — and the
    // session it connected was an administrator shell.
    const d = decideHostKey(fingerprint(KEY_A), fingerprint(KEY_B))
    expect(d.trust).toBe(false)
    expect(d.status).toBe('mismatch')
    expect(d.expected).toBe(fingerprint(KEY_A))
  })

  it('does not record on a mismatch', () => {
    // Recording here would overwrite the good key with the attacker's and make
    // every later connection look fine.
    expect(decideHostKey(fingerprint(KEY_A), fingerprint(KEY_B)).remember).toBeFalsy()
  })

  it('refuses when no fingerprint could be computed', () => {
    expect(decideHostKey(fingerprint(KEY_A), '')).toMatchObject({ trust: false })
    expect(decideHostKey(undefined, null)).toMatchObject({ trust: false })
  })

  it('never returns trust:true for a mismatch, whatever the inputs', () => {
    for (const known of ['a', 'b', 'x'.repeat(43)]) {
      for (const actual of ['c', 'd', 'y'.repeat(43)]) {
        const d = decideHostKey(known, actual)
        if (known !== actual) expect(d.trust).toBe(false)
      }
    }
  })
})

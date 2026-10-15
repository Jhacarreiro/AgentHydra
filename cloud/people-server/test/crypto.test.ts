import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { type Keyring, keyringFromEnv, open, seal } from '../src/crypto'

const ring = (): Keyring => ({ current: 1, keys: new Map([[1, randomBytes(32)]]) })
const msg = new TextEncoder().encode('a person doc')

describe('crypto', () => {
  test('round trip', () => {
    const r = ring()
    const s = seal(r, 'sub-1', msg, 'user:sub-1/d1/1')
    expect(s.keyId).toBe(1)
    expect(s.nonce.length).toBe(12)
    expect(open(r, 'sub-1', s, 'user:sub-1/d1/1').toString()).toBe('a person doc')
  })

  test('nonce differs per seal', () => {
    const r = ring()
    expect(Buffer.from(seal(r, 'u', msg).nonce).equals(Buffer.from(seal(r, 'u', msg).nonce))).toBe(
      false,
    )
  })

  test('tampered ciphertext, nonce or aad fails', () => {
    const r = ring()
    const s = seal(r, 'u', msg, 'x')
    const ct = Buffer.from(s.ciphertext)
    ct[0]! ^= 1
    expect(() => open(r, 'u', { ...s, ciphertext: ct }, 'x')).toThrow()
    const n = Buffer.from(s.nonce)
    n[0]! ^= 1
    expect(() => open(r, 'u', { ...s, nonce: n }, 'x')).toThrow()
    expect(() => open(r, 'u', s, 'y')).toThrow()
  })

  test('wrong master key or wrong user fails', () => {
    const r = ring()
    const s = seal(r, 'u', msg)
    expect(() => open(ring(), 'u', s)).toThrow()
    expect(() => open(r, 'other', s)).toThrow()
  })

  test('rotation: old rows open with their key_id, new writes use the new one', () => {
    const k1 = randomBytes(32)
    const old = seal({ current: 1, keys: new Map([[1, k1]]) }, 'u', msg)
    const rotated: Keyring = {
      current: 2,
      keys: new Map([
        [1, k1],
        [2, randomBytes(32)],
      ]),
    }
    expect(open(rotated, 'u', old).toString()).toBe('a person doc')
    expect(seal(rotated, 'u', msg).keyId).toBe(2)
  })

  test('keyringFromEnv', () => {
    const a = randomBytes(32).toString('base64')
    const b = randomBytes(32).toString('base64')
    const r = keyringFromEnv(`1:${a},2:${b}`)
    expect(r.current).toBe(2)
    expect(() => keyringFromEnv('1:c2hvcnQ=')).toThrow()
  })
})

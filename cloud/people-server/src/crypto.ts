import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export interface Keyring {
  /** key_id used for new writes. */
  current: number
  /** master keys (32 bytes each) by key_id; keep old ones to read old rows. */
  keys: Map<number, Uint8Array>
}

export interface Sealed {
  ciphertext: Uint8Array // ciphertext || 16-byte GCM tag
  nonce: Uint8Array
  keyId: number
}

const TAG = 16

export function userKey(master: Uint8Array, sub: string, keyId: number): Buffer {
  if (master.length !== 32) throw new Error('master key must be 32 bytes')
  const info = Buffer.from(`agenthydra-people/v1/key:${keyId}/sub:${sub}`, 'utf8')
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32))
}

/** `aad` binds the ciphertext to its row (e.g. `${scope}/${docId}/${version}`). */
export function seal(ring: Keyring, sub: string, plaintext: Uint8Array, aad = ''): Sealed {
  const master = ring.keys.get(ring.current)
  if (!master) throw new Error(`no master key for key_id ${ring.current}`)
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', userKey(master, sub, ring.current), nonce)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
  return { ciphertext: ct, nonce, keyId: ring.current }
}

export function open(ring: Keyring, sub: string, sealed: Sealed, aad = ''): Buffer {
  const master = ring.keys.get(sealed.keyId)
  if (!master) throw new Error(`no master key for key_id ${sealed.keyId}`)
  if (sealed.ciphertext.length < TAG) throw new Error('ciphertext too short')
  const buf = Buffer.from(sealed.ciphertext)
  const d = createDecipheriv(
    'aes-256-gcm',
    userKey(master, sub, sealed.keyId),
    Buffer.from(sealed.nonce),
  )
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(buf.subarray(buf.length - TAG))
  return Buffer.concat([d.update(buf.subarray(0, buf.length - TAG)), d.final()])
}

/** Parse `PEOPLE_MASTER_KEYS` like `1:<base64>,2:<base64>`; the highest id is current. */
export function keyringFromEnv(spec: string): Keyring {
  const keys = new Map<number, Uint8Array>()
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf(':')
    const id = Number(part.slice(0, i))
    if (!Number.isInteger(id) || id < 0) throw new Error('bad key id in master key spec')
    const key = Buffer.from(part.slice(i + 1), 'base64')
    if (key.length !== 32) throw new Error(`master key ${id} must decode to 32 bytes`)
    keys.set(id, key)
  }
  if (!keys.size) throw new Error('no master keys configured')
  return { current: Math.max(...keys.keys()), keys }
}

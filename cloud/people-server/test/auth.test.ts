import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { AuthError, createVerifier } from '../src/auth'

const ISS = 'https://id.example.test'
const AUD = 'https://site.example.test'

let priv: CryptoKey
let otherPriv: CryptoKey
let jwks: { keys: any[] }
let server: ReturnType<typeof Bun.serve>
let verify: ReturnType<typeof createVerifier>

async function mint(
  o: {
    iss?: string
    aud?: string
    exp?: string | number
    nbf?: string | number
    kid?: string
    key?: CryptoKey
    sub?: string
  } = {},
) {
  const j = new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'k1' })
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
  if (o.sub !== '') j.setSubject(o.sub ?? 'user-123')
  j.setExpirationTime(o.exp ?? '5m')
  if (o.nbf !== undefined) j.setNotBefore(o.nbf)
  return j.sign(o.key ?? priv)
}

beforeAll(async () => {
  const a = await generateKeyPair('RS256')
  const b = await generateKeyPair('RS256', { extractable: true })
  priv = a.privateKey
  otherPriv = b.privateKey
  jwks = { keys: [{ ...(await exportJWK(a.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] }
  server = Bun.serve({ port: 0, fetch: () => Response.json(jwks) })
  verify = createVerifier({
    jwksUrl: `http://localhost:${server.port}/oauth/jwks`,
    issuer: ISS,
    audience: AUD,
  })
})
afterAll(() => server.stop(true))

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')

describe('auth', () => {
  test('accepts a good token and returns sub', async () => {
    expect((await verify(await mint())).sub).toBe('user-123')
  })
  test('rejects expired (beyond 30 s skew) but allows within skew', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expect(verify(await mint({ exp: now - 120 }))).rejects.toBeInstanceOf(AuthError)
    expect((await verify(await mint({ exp: now - 10 }))).sub).toBe('user-123')
  })
  test('rejects not-yet-valid nbf beyond skew', async () => {
    await expect(
      verify(await mint({ nbf: Math.floor(Date.now() / 1000) + 300 })),
    ).rejects.toBeInstanceOf(AuthError)
  })
  test('rejects wrong aud and wrong iss', async () => {
    await expect(verify(await mint({ aud: 'client-id-123' }))).rejects.toBeInstanceOf(AuthError)
    await expect(verify(await mint({ iss: 'https://evil.example.test' }))).rejects.toBeInstanceOf(
      AuthError,
    )
  })
  test('rejects a missing sub', async () => {
    await expect(verify(await mint({ sub: '' }))).rejects.toBeInstanceOf(AuthError)
  })
  test('rejects alg none', async () => {
    const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISS, aud: AUD, sub: 'x', exp: Math.floor(Date.now() / 1000) + 300 })}.`
    await expect(verify(t)).rejects.toBeInstanceOf(AuthError)
  })
  test('rejects HS256', async () => {
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject('x')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('s'.repeat(32)))
    await expect(verify(t)).rejects.toBeInstanceOf(AuthError)
  })
  test('rejects a token signed by another key under a known kid', async () => {
    await expect(verify(await mint({ key: otherPriv }))).rejects.toBeInstanceOf(AuthError)
  })
  test('unknown kid is rejected, then accepted after the JWKS publishes it (refetch)', async () => {
    const t = await mint({ kid: 'k2', key: otherPriv })
    await expect(verify(t)).rejects.toBeInstanceOf(AuthError)
    // publish k2 (derive public part from otherPriv)
    const { d, p, q, dp, dq, qi, ...pubOnly } = await exportJWK(otherPriv)
    jwks.keys.push({ ...pubOnly, kid: 'k2', alg: 'RS256', use: 'sig' })
    await Bun.sleep(1100) // jose refetch cooldown configured to 1 s
    expect((await verify(t)).sub).toBe('user-123')
  })
})

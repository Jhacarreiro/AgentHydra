import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

export interface AuthConfig {
  /** Public JWKS URL of the issuer (used unless `keys` is given). */
  jwksUrl?: string
  /** Test/offline override: any jose key resolver (e.g. createLocalJWKSet). */
  keys?: JWTVerifyGetKey
  issuer: string
  /** The issuer's site URL, NOT the client id. */
  audience: string
  skewSeconds?: number
  /** JWKS cache lifetime; an unknown kid triggers a refetch (jose cooldown applies). */
  cacheMs?: number
}

export class AuthError extends Error {}

export function createVerifier(
  cfg: AuthConfig,
): (token: string) => Promise<{ sub: string; exp?: number }> {
  const getKey =
    cfg.keys ??
    (cfg.jwksUrl
      ? createRemoteJWKSet(new URL(cfg.jwksUrl), {
          cacheMaxAge: cfg.cacheMs ?? 600_000,
          cooldownDuration: 1_000,
          timeoutDuration: 5_000,
        })
      : undefined)
  if (!getKey) throw new Error('auth needs jwksUrl or keys')
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, getKey, {
        algorithms: ['RS256'],
        issuer: cfg.issuer,
        audience: cfg.audience,
        clockTolerance: cfg.skewSeconds ?? 30,
        requiredClaims: ['sub', 'exp'],
      })
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no sub')
      return { sub: payload.sub, exp: payload.exp }
    } catch (e) {
      throw new AuthError(e instanceof Error ? e.message : 'invalid token')
    }
  }
}

export const MAX_BODY_BYTES = 600 * 1024
export const MAX_DOC_BYTES = 512 * 1024
export const MAX_USER_BYTES = 8 * 1024 * 1024
export const MAX_USER_DOCS = 200
export const PAGE_SIZE = 100
export const DOC_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

export const isDocId = (s: string): boolean => DOC_ID_RE.test(s)

/** Fixed one-minute windows; small and good enough for a single process. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>()
  constructor(
    private max: number,
    private windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Counts one hit; true while under the limit. */
  take(key: string): boolean {
    const t = this.now()
    if (this.hits.size > 10_000) this.sweep(t)
    const h = this.hits.get(key)
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { start: t, n: 1 })
      return true
    }
    h.n++
    return h.n <= this.max
  }

  /** True when the key is already over the limit; does not count. */
  blocked(key: string): boolean {
    const h = this.hits.get(key)
    return !!h && this.now() - h.start < this.windowMs && h.n >= this.max
  }

  private sweep(t: number) {
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k)
  }
}

export interface Limiters {
  ip: RateLimiter
  authFail: RateLimiter
  read: RateLimiter
  write: RateLimiter
}

export function makeLimiters(now?: () => number): Limiters {
  return {
    ip: new RateLimiter(120, 60_000, now),
    authFail: new RateLimiter(10, 60_000, now),
    read: new RateLimiter(60, 60_000, now),
    write: new RateLimiter(20, 60_000, now),
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** CF-Connecting-IP counts only when the TCP peer is loopback (Caddy); otherwise the peer address. */
export function clientIp(peer: string | undefined, header: string | null, trust: boolean): string {
  const p = peer ?? 'unknown'
  if (trust && LOOPBACK.has(p) && header) {
    const h = header.trim()
    if (h && h.length <= 45 && /^[0-9a-fA-F:.]+$/.test(h)) return h
  }
  return p
}

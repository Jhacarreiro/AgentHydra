import { AuthError, createVerifier } from './auth'
import { type Config, loadConfig } from './config'
import { type Db, openDb } from './db'
import { health } from './health'
import { clientIp, type Limiters, makeLimiters, MAX_BODY_BYTES } from './limits'
import { meRoutes, peopleMeModule } from './me'
import { PeopleStore } from './modules/people/store'
import { peopleRoutes } from './modules/people/routes'
import { type Ctx, errorBody, HttpError, json, match, type Route } from './router'

export interface AppDeps {
  db: Db
  cfg: Pick<Config, 'auth' | 'keyring' | 'auditSalt' | 'writeBlockFile' | 'backupStampFile' | 'trustProxyHeader'>
  limiters?: Limiters
  jwksCheck?: () => Promise<boolean>
  log?: (line: string) => void
}

export function createApp(deps: AppDeps) {
  const { db, cfg } = deps
  const limiters = deps.limiters ?? makeLimiters()
  const log = deps.log ?? ((l: string) => console.log(l))
  const verify = createVerifier(cfg.auth)
  const store = new PeopleStore(db, cfg.keyring, cfg.auditSalt)
  const routes: Route[] = [
    ...peopleRoutes(store),
    ...meRoutes(store, [peopleMeModule(store)]),
  ]

  async function handle(req: Request, peer?: string): Promise<Response> {
    const t0 = Date.now()
    const requestId = crypto.randomUUID()
    const url = new URL(req.url)
    const res = await route(req, url, peer, requestId).catch((e) => {
      if (e instanceof HttpError) return errorBody(e.status, e.message, e.hint, e.extra)
      // Never echo internals; the message itself could carry row data.
      log(JSON.stringify({ level: 'error', id: requestId, name: (e as Error)?.name ?? 'Error' }))
      return errorBody(500, 'internal error', 'Try again later.')
    })
    // Method and path only: no headers, no query string, no bodies.
    log(
      JSON.stringify({
        id: requestId,
        method: req.method,
        path: url.pathname,
        status: res.status,
        ms: Date.now() - t0,
      }),
    )
    return res
  }

  async function route(req: Request, url: URL, peer: string | undefined, requestId: string) {
    const ip = clientIp(peer, req.headers.get('cf-connecting-ip'), cfg.trustProxyHeader)
    if (!limiters.ip.take(ip)) return errorBody(429, 'too many requests', 'Slow down and retry.')

    if (url.pathname === '/healthz' && req.method === 'GET') {
      const h = await health({ db, cfg, jwksCheck: deps.jwksCheck })
      return json(h.db === 'ok' && h.jwks === 'ok' ? 200 : 503, h)
    }

    const { route: r, params, methodNotAllowed } = match(routes, req.method, url.pathname)

    // Auth comes before the route lookup so unknown paths do not reveal the API to anonymous callers.
    if (limiters.authFail.blocked(ip))
      return errorBody(429, 'too many failed sign-ins', 'Wait a minute and retry.')
    const token = /^Bearer (\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
    let sub: string
    try {
      if (!token) throw new AuthError('missing token')
      sub = (await verify(token)).sub
    } catch (e) {
      if (!(e instanceof AuthError)) throw e
      limiters.authFail.take(ip)
      return errorBody(401, 'unauthorized', 'Sign in again.')
    }

    if (!r) return methodNotAllowed ? errorBody(405, 'method not allowed') : errorBody(404, 'not found')
    if (!(r.write ? limiters.write : limiters.read).take(sub))
      return errorBody(429, 'too many requests', 'Slow down and retry.')
    if (await store.isDeleted(sub)) return errorBody(403, 'account deleted', 'This account was erased.')

    if (r.write && (await Bun.file(cfg.writeBlockFile).exists()))
      return errorBody(503, 'storage full', 'Writes are paused; reads still work.')

    let body: unknown
    if (r.body) {
      const len = Number(req.headers.get('content-length') ?? 0)
      if (len > MAX_BODY_BYTES) return errorBody(413, 'body too large', 'At most 600 KB.')
      const text = await req.text()
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) return errorBody(413, 'body too large', 'At most 600 KB.')
      try {
        body = JSON.parse(text)
      } catch {
        return errorBody(400, 'bad json')
      }
    }
    const ctx: Ctx = { req, sub, params, url, requestId, body }
    return r.handler(ctx)
  }

  return { handle, store }
}

if (import.meta.main) {
  const cfg = loadConfig()
  const { db } = openDb(cfg.databaseUrl)
  const app = createApp({ db, cfg })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,
    maxRequestBodySize: MAX_BODY_BYTES + 1024,
    fetch: (req, s) => app.handle(req, s.requestIP(req)?.address),
  })
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: server.port }))
}

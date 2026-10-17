// Hydra Desk server: Hono routes, the /ws hub, plugins, and the built window in production.

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono, type MiddlewareHandler } from 'hono'
import type { ClientEvent, ServerEvent } from '@shared/protocol'
import pkg from '../package.json'
import { type HelloEvent, type HelloProvider, type HostRoute, type Plugin, type ServerContext, setContext, type WsRoute } from './context'
import { REAL_HOME } from './real-home'
import { createSettingsStore, SettingsError } from './settings'
import { indexReader } from './static-index'
import { cacheControl } from './static-cache'
import { createWsHub, type WsClient } from './ws'

export const VERSION: string = pkg.version
const STARTED_AT = Date.now()

const DEFAULT_PLUGINS_DIR = join(import.meta.dir, 'plugins')
const WEB_DIST = resolve(import.meta.dir, '../../web/dist')

export interface CreateServerOptions {
  port: number
  home: string
  /** Folder of plugin files (default server/src/plugins). */
  pluginsDir?: string
  /** Handed to plugins as ctx.deps (tests inject fakes here). */
  deps?: Record<string, unknown>
  /** Folder of the built window (default web/dist); served only when it exists. */
  webDist?: string
  hostname?: string
  /** Canonical origins (`parsePublicOrigins`) a sign-in proxy puts in front of the window; default none. */
  publicOrigins?: readonly string[]
}

export interface DeskServer {
  url: string
  port: number
  ctx: ServerContext
  stop(): Promise<void>
}

/** The names this server answers to. A browser naming anything else is another site's page, or a DNS name
 *  rebound to this machine; either could otherwise drive every route here. The one exception is an origin listed
 *  in HYDRA_DESK_PUBLIC_ORIGINS (`foreignRequest`'s `trusted`): Desk has no sign-in of its own, so listing a name
 *  that a sign-in proxy does not guard hands this machine's chats and shell to whoever finds it. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** A bare origin written `scheme://host[:port]`, with an optional trailing slash and nothing else. */
const ORIGIN_SHAPE = /^https?:\/\/[^/@?#*]+\/?$/i

/** One HYDRA_DESK_PUBLIC_ORIGINS entry: its canonical origin (`https://desk.example.test`, lower case, no default
 *  port), or the reason it is refused. Only https is allowed, except for a loopback name. */
function publicOrigin(entry: string): { origin: string } | { refused: string } {
  if (!ORIGIN_SHAPE.test(entry)) return { refused: 'not a bare origin' }
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return { refused: 'not a URL' }
  }
  if (url.hostname.endsWith('.')) return { refused: 'a trailing dot' }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) return { refused: 'https only' }
  return { origin: url.origin }
}

/** The public origins HYDRA_DESK_PUBLIC_ORIGINS may list, canonical, and the entries it refused as typed, each with
 *  its reason. Parsed once at startup, so a typo is named in the log instead of dropped. */
export function parsePublicOrigins(raw: string | undefined): { origins: string[]; ignored: string[] } {
  const origins: string[] = []
  const ignored: string[] = []
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const parsed = publicOrigin(entry)
    if ('refused' in parsed) ignored.push(`${entry} (${parsed.refused})`)
    else if (!origins.includes(parsed.origin)) origins.push(parsed.origin)
  }
  return { origins, ignored }
}

/** Whether a Host header (any case) names one of the trusted origins. Compares URL.host, which is lower case. */
function trustedHost(host: string, trusted: readonly string[]): boolean {
  const name = host.toLowerCase()
  return trusted.some((origin) => new URL(origin).host === name)
}

/** A Host that names a listed public origin, not this machine: the case where the sign-in proxy's pages are served. */
function listedHost(host: string | null, trusted: readonly string[]): boolean {
  return host !== null && !isLocalHost(host, false) && trustedHost(host, trusted)
}

/** `value` is a Host header (host[:port]) or, with `isOrigin`, an Origin (scheme://host[:port]); any port passes. */
function isLocalHost(value: string, isOrigin: boolean): boolean {
  if (!isOrigin && /[\s@/\\?#]/.test(value)) return false
  try {
    return LOCAL_HOSTS.has(new URL(isOrigin ? value : `http://${value}`).hostname)
  } catch {
    // 'null' (a file:// page, a sandboxed frame) and anything else unreadable is not this machine.
    return false
  }
}

/** The start pages of the window: the only paths a sign-in proxy's redirect may land on. The window's client routing is
 *  hash-based, so a start page is all a redirect needs. Every other path, including a route added later, is refused. */
const LISTED_START_PATHS = new Set(['/', '/index.html', '/ah', '/ah/', '/ah/index.html'])

/** A top-level page load of a start page (`LISTED_START_PATHS`) of a listed host: a GET or HEAD document navigation.
 *  A sign-in proxy's redirect back to the listed name arrives cross-site (or same-site from a sibling name), so this
 *  lets the first page through. */
function listedPageNavigation(headers: Headers, method: string, path: string, trusted: readonly string[]): boolean {
  if (!listedHost(headers.get('host'), trusted)) return false
  if (method !== 'GET' && method !== 'HEAD') return false
  if (headers.get('sec-fetch-mode') !== 'navigate' || headers.get('sec-fetch-dest') !== 'document') return false
  return LISTED_START_PATHS.has(path)
}

/** On a listed Host, an Origin passes only when it is the listed origin that names that same Host. */
function listedOrigin(host: string | null, origin: string, trusted: readonly string[]): boolean {
  return host !== null && trusted.some((o) => o === origin && new URL(o).host === host.toLowerCase())
}

/** Why a request must be refused, or null. Requests without these headers (curl, the SDK, tests) pass. `trusted` are
 *  the public origins (HYDRA_DESK_PUBLIC_ORIGINS). On a listed host the Origin must be that host's own listed origin;
 *  loopback Origins are refused there, and on a loopback Host the Origin rule is origin/main's, listed or not.
 *  On a listed host a same-site request is refused too: a sibling name is same-site, so it could be any page on the
 *  domain. A cross-site fetch, that same-site request and an Origin of `null` are refused whatever is listed, except
 *  a page navigation to a listed host (`listedPageNavigation`). */
export function foreignRequest(headers: Headers, trusted: readonly string[] = [], method = 'GET', path = '/'): string | null {
  const host = headers.get('host')
  const listed = listedHost(host, trusted)
  if (host !== null && !isLocalHost(host, false) && !listed) {
    return `this server only answers to 127.0.0.1 or localhost, not ${host}`
  }
  const origin = headers.get('origin')
  const originOk = listed ? listedOrigin(host, origin ?? '', trusted) : isLocalHost(origin ?? '', true)
  if (origin !== null && !originOk) return `requests from ${origin} are refused`
  const site = headers.get('sec-fetch-site')
  const otherSite = site === 'cross-site' || (site === 'same-site' && listed)
  if (otherSite && !listedPageNavigation(headers, method, path, trusted)) return 'cross-site requests are refused'
  return null
}

/** Answers 403 to a request from another site or a rebound DNS name, before any route sees it. */
export function localOnly(trusted: readonly string[] = []): MiddlewareHandler {
  return async (c, next) => {
    const why = foreignRequest(c.req.raw.headers, trusted, c.req.method, c.req.path)
    if (why) return c.json({ error: why }, 403)
    await next()
  }
}

/** On a listed host the window's pages (and /ah/) may be framed only by this same site, and no other page gets a
 *  handle on the window through `window.opener`. Loopback sends none of these. */
const LISTED_PAGE_HEADERS = {
  'content-security-policy': "frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-opener-policy': 'same-origin',
}

function listedPageHeaders(trusted: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    await next()
    // After the route: a header set before it is not carried onto the response the route returns.
    if (listedHost(c.req.header('host') ?? null, trusted)) {
      for (const [name, value] of Object.entries(LISTED_PAGE_HEADERS)) c.res.headers.set(name, value)
    }
  }
}

/** Every *.ts file in dir (not .d.ts / .test.ts), sorted by file name. */
function pluginFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => join(dir, f))
}

/** A /ws message from the window, or null when it is not one. */
function parseClientEvent(message: string | Buffer): ClientEvent | null {
  try {
    const event = JSON.parse(String(message)) as ClientEvent | null
    return typeof event?.type === 'string' ? event : null
  } catch {
    return null
  }
}

async function loadPlugins(app: Hono, ctx: ServerContext, dir: string): Promise<void> {
  const started = performance.now()
  const took: { file: string; ms: number }[] = []
  for (const file of pluginFiles(dir)) {
    const at = performance.now()
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: Plugin }
      if (typeof mod.default !== 'function') {
        console.error(`[plugins] ${file} has no default export function; skipped`)
        continue
      }
      await mod.default(app, ctx)
    } catch (err) {
      // One broken plugin must not take the others (or the window) down with it.
      console.error(`[plugins] ${file} failed to load:`, err)
    }
    took.push({ file, ms: performance.now() - at })
  }
  const slowest = took
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((p) => `${basename(p.file)} ${Math.round(p.ms)} ms`)
  console.log(`[plugins] loaded in ${Math.round(performance.now() - started)} ms; slowest: ${slowest.join(', ')}`)
}

function serveStatic(app: Hono, dist: string): void {
  const readIndex = indexReader(join(dist, 'index.html'))
  app.get('*', async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname)
    const file = resolve(dist, `.${path}`)
    if (file === dist || file.startsWith(dist + sep)) {
      const found = Bun.file(file)
      // One async stat: a folder or a missing file falls through to the window's index.
      const isFile = await found.stat().then((st) => st.isFile(), () => false)
      if (isFile) return new Response(found, { headers: { 'cache-control': cacheControl(path) } })
    }
    const html = await readIndex()
    if (html === null) return new Response('the window is not built yet', { status: 503 })
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  })
}

export async function createServer(opts: CreateServerOptions): Promise<DeskServer> {
  const home = resolve(opts.home)
  mkdirSync(home, { recursive: true })
  // The same canonical form as the env parser: a caller's bare host name is not trusted as a scheme-less origin.
  const publicOrigins = (opts.publicOrigins ?? []).flatMap((entry) => {
    const parsed = publicOrigin(entry)
    return 'origin' in parsed ? [parsed.origin] : []
  })

  const hub = createWsHub()
  const settings = createSettingsStore(home)
  const stopHooks: (() => void | Promise<void>)[] = [() => settings.flushSync()]
  const connectHooks: ((send: (event: ServerEvent) => void) => void)[] = []
  const wsRoutes = new Map<string, WsRoute>()
  const hostRoutes: HostRoute[] = []
  const routeOf = (ws: WsClient) => (ws.data as { route: WsRoute; data: unknown } | undefined) ?? null
  // No chat list until the engine registers its own: an empty one would read as every chat gone.
  let hello: HelloProvider = () => ({ type: 'hello', version: VERSION, settings: settings.get() })
  const helloExtensions: ((h: HelloEvent) => HelloEvent | Promise<HelloEvent>)[] = []
  const helloNow = async (): Promise<HelloEvent> => {
    let h = await hello()
    for (const extend of helloExtensions) h = await extend(h)
    return h
  }

  let base = `http://127.0.0.1:${opts.port}`
  const ctx: ServerContext = {
    home,
    version: VERSION,
    url: () => base,
    broadcast: hub.broadcast,
    settings: settings.get,
    updateSettings: (patch) => {
      const next = settings.update(patch)
      hub.broadcast({ type: 'settings.update', settings: next })
      return next
    },
    registerHello: (fn) => {
      hello = fn
    },
    extendHello: (fn) => void helloExtensions.push(fn),
    wsClientCount: hub.clientCount,
    wsVisibleCount: hub.visibleCount,
    onWsVisibility: hub.onVisibility,
    onConnect: (fn) => void connectHooks.push(fn),
    wsRoute: (path, route) => void wsRoutes.set(path, route as WsRoute),
    hostRoute: (route) => void hostRoutes.push(route),
    onStop: (fn) => void stopHooks.push(fn),
    deps: opts.deps ?? {},
  }
  setContext(ctx)

  const app = new Hono()
  app.onError((err, c) => {
    console.error('[server]', err)
    return c.json({ error: err.message || String(err) }, 500)
  })
  // First, so it covers every route the plugins add and the built window.
  app.use('*', listedPageHeaders(publicOrigins))
  app.use('*', localOnly(publicOrigins))

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, startedAt: STARTED_AT }))
  app.get('/api/settings', (c) => c.json(settings.get()))
  app.put('/api/settings', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'the body must be JSON' }, 400)
    }
    try {
      const next = settings.update(body)
      hub.broadcast({ type: 'settings.update', settings: next })
      return c.json(next)
    } catch (err) {
      if (err instanceof SettingsError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  await loadPlugins(app, ctx, opts.pluginsDir ?? DEFAULT_PLUGINS_DIR)

  app.all('/api/*', (c) => c.json({ error: `no route ${c.req.method} ${new URL(c.req.url).pathname}` }, 404))
  const dist = resolve(opts.webDist ?? WEB_DIST)
  serveStatic(app, dist)

  const server = Bun.serve<unknown>({
    port: opts.port,
    hostname: opts.hostname ?? '127.0.0.1',
    // Bun closes an HTTP request that sends nothing for 10 s by default (`websocket.idleTimeout` below is the
    // sockets' own). /dw/api goes on to the dev-servers service, whose list takes 11-13 s cold on a busy box and
    // whose ensure waits up to ~45 s for a server: every such call was cut at 8-12 s with no answer, so `dev_servers`
    // said AgentHydra did not answer (2026-10-11). The service itself allows 255 s.
    idleTimeout: 255,
    async fetch(req, srv) {
      // A `<label>.localhost` host (the dev-server proxy) is the route's own to judge: the guard below would refuse it.
      const host = req.headers.get('host')
      const byHost = host === null || hostRoutes.length === 0 ? undefined : hostRoutes.find((r) => r.match(host))
      if (byHost) {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return byHost.fetch(req)
        const accepted = await byHost.ws.accept(req)
        if (accepted instanceof Response) return accepted
        if (srv.upgrade(req, { data: { route: byHost.ws, data: accepted.data }, headers: accepted.headers })) return undefined
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      const route = wsRoutes.get(new URL(req.url).pathname)
      if (route) {
        const why = foreignRequest(req.headers, publicOrigins, req.method, new URL(req.url).pathname)
        if (why) return Response.json({ error: why }, { status: 403 })
        const accepted = await route.accept(req)
        if (accepted instanceof Response) return accepted
        if (srv.upgrade(req, { data: { route, data: accepted.data }, headers: accepted.headers })) return undefined
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      if (new URL(req.url).pathname === '/ws') {
        // The upgrade does not go through Hono, so it gets the same guard (and the same list) here.
        const why = foreignRequest(req.headers, publicOrigins, req.method, new URL(req.url).pathname)
        if (why) return Response.json({ error: why }, { status: 403 })
        if (srv.upgrade(req, { data: undefined })) return undefined
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      return app.fetch(req, { server: srv })
    },
    websocket: {
      // Bun pings each socket and closes one that answers nothing for this long, so a half-open
      // window (crashed, asleep) leaves the client counts.
      sendPings: true,
      idleTimeout: 60,
      async open(ws: WsClient) {
        const own = routeOf(ws)
        if (own) return own.route.open(ws, own.data)
        hub.addClient(ws)
        try {
          hub.send(ws, await helloNow())
        } catch (err) {
          console.error('[ws] hello provider failed:', err)
        }
        for (const fn of connectHooks) {
          try {
            fn((event) => hub.send(ws, event))
          } catch (err) {
            console.error('[ws] connect hook failed:', err)
          }
        }
      },
      message(ws: WsClient, message) {
        const own = routeOf(ws)
        if (own) return own.route.message(ws, own.data, message)
        // The hub's client says when it is shown or hidden (ClientEvent); a ping needs no answer.
        const event = parseClientEvent(message)
        if (event?.type === 'visibility') hub.setVisible(ws, event.visible === true)
      },
      close(ws: WsClient) {
        const own = routeOf(ws)
        if (own) return own.route.close(ws, own.data)
        hub.removeClient(ws)
      },
    },
  })

  const port = server.port as number
  base = `http://127.0.0.1:${port}`
  return {
    url: base,
    port,
    ctx,
    async stop() {
      for (const fn of stopHooks.splice(0)) {
        try {
          await fn()
        } catch (err) {
          console.error('[server] stop hook failed:', err)
        }
      }
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.HYDRA_DESK_PORT) || 7798
  const home = process.env.HYDRA_DESK_HOME || REAL_HOME
  const publicList = parsePublicOrigins(process.env.HYDRA_DESK_PUBLIC_ORIGINS)
  const desk = await createServer({ port, home, publicOrigins: publicList.origins })
  if (publicList.origins.length) console.log(`[desk] trusts ${publicList.origins.join(', ')} like loopback (HYDRA_DESK_PUBLIC_ORIGINS)`)
  if (publicList.ignored.length) console.warn(`[desk] HYDRA_DESK_PUBLIC_ORIGINS ignored ${publicList.ignored.join(', ')}: only bare origins count, https unless loopback`)
  console.log(`AgentHydra ${VERSION} on ${desk.url} (home ${home})`)
  const shutdown = async () => {
    await desk.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (err) => console.error(`[desk] uncaught: ${err?.stack ?? err}`))
  process.on('unhandledRejection', (err) => console.error(`[desk] unhandled rejection: ${(err as Error)?.stack ?? err}`))
}

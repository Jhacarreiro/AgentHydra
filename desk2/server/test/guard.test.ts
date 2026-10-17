// The local-only guard (index.ts localOnly / foreignRequest): another site's page, or a DNS name rebound to
// 127.0.0.1, gets a 403 from every route and from the /ws upgrade. The window, Vite's dev server on its own
// port and clients that send no Host or Origin (curl, the SDK, tests) pass.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createServer, type DeskServer, foreignRequest, localOnly, parsePublicOrigins } from '../src/index'

const temps: string[] = []
const servers: DeskServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const app = new Hono()
app.use('*', localOnly())
app.post('/api/folders/reveal', (c) => c.json({ ok: true }))

const ask = (headers: Record<string, string>) => app.request('/api/folders/reveal', { method: 'POST', headers })

const PASS: Record<string, string>[] = [
  {},
  { host: '127.0.0.1:7795' },
  { host: 'localhost' },
  { host: '[::1]:7795' },
  { host: '127.0.0.1:7795', origin: 'http://127.0.0.1:7795', 'sec-fetch-site': 'same-origin' },
  // Vite's dev server proxies with the browser's own Host and Origin
  { host: 'localhost:4795', origin: 'http://localhost:4795', 'sec-fetch-site': 'same-origin' },
  { host: 'LOCALHOST:7795', origin: 'http://[::1]:5173', 'sec-fetch-site': 'same-site' },
]

const REFUSE: Record<string, string>[] = [
  { host: 'evil.example' },
  { host: 'rebound.evil.example:7795' },
  { host: '127.0.0.1.evil.example:7795' },
  { host: 'evil.example@127.0.0.1:7795' },
  { host: '192.168.1.20:7795' },
  { origin: 'https://evil.example' },
  { origin: 'http://127.0.0.1.evil.example' },
  { origin: 'null' },
  { host: '127.0.0.1:7795', origin: 'https://evil.example' },
  { host: '127.0.0.1:7795', 'sec-fetch-site': 'cross-site' },
]

describe('foreignRequest', () => {
  test('passes this machine on any port and requests without the headers', () => {
    for (const h of PASS) expect(foreignRequest(new Headers(h))).toBeNull()
  })

  test('refuses another host, another origin and a cross-site fetch', () => {
    for (const h of REFUSE) expect(typeof foreignRequest(new Headers(h))).toBe('string')
  })
})

describe('localOnly', () => {
  test('a route answers this machine and 403 {error} to anything else', async () => {
    for (const h of PASS) expect((await ask(h)).status).toBe(200)
    for (const h of REFUSE) {
      const res = await ask(h)
      expect(res.status).toBe(403)
      expect(typeof ((await res.json()) as { error?: unknown }).error).toBe('string')
    }
  })

  test('the real server refuses another origin on its routes and its websocket upgrade', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-guard-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-guard-plugins-'))
    temps.push(home, plugins)
    const desk = await createServer({ port: 0, home, pluginsDir: plugins })
    servers.push(desk)

    expect((await fetch(`${desk.url}/api/health`)).status).toBe(200)
    const health = await fetch(`${desk.url}/api/health`, { headers: { origin: 'https://evil.example' } })
    expect(health.status).toBe(403)
    expect(((await health.json()) as { error: string }).error).toContain('evil.example')
    expect((await fetch(`${desk.url}/api/settings`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    // /ws is answered outside Hono: the guard comes before the upgrade
    expect((await fetch(`${desk.url}/ws`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${desk.url}/ws`)).status).toBe(426)
  })
})

// A sign-in proxy in front of the window passes the browser's own Host and Origin through, so the listed name must
// reach every route and the /ws upgrade (outside Hono), and nothing else may. Fail-closed (a 403 on the listed name)
// and fail-open (the list skipped on one path) both show here.
describe('public origins', () => {
  const PUBLIC = 'https://desk.example.test'
  const TRUSTED = [PUBLIC]
  const PROXIED = { host: 'desk.example.test', origin: PUBLIC, 'sec-fetch-site': 'same-origin' }
  const NAVIGATION = { host: 'desk.example.test', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

  test('parsePublicOrigins keeps the canonical origin and names what it refuses', () => {
    expect(parsePublicOrigins('HTTPS://Desk.Example.Test/')).toEqual({ origins: [PUBLIC], ignored: [] })
    // The default port and the trailing slash are harmless spellings of the same origin.
    expect(parsePublicOrigins('https://desk.example.test:443, http://localhost:8080').origins).toEqual([
      PUBLIC,
      'http://localhost:8080',
    ])
    expect(parsePublicOrigins(undefined)).toEqual({ origins: [], ignored: [] })
  })

  test('parsePublicOrigins refuses a path, a query, userinfo, a wildcard, another scheme and null', () => {
    const raw = 'https://desk.example.test/app, https://*.example.test, ftp://desk.example.test, null, https://me@desk.example.test, https://desk.example.test?x=1'
    expect(parsePublicOrigins(raw)).toEqual({
      origins: [],
      ignored: [
        'https://desk.example.test/app (not a bare origin)',
        'https://*.example.test (not a bare origin)',
        'ftp://desk.example.test (not a bare origin)',
        'null (not a bare origin)',
        'https://me@desk.example.test (not a bare origin)',
        'https://desk.example.test?x=1 (not a bare origin)',
      ],
    })
  })

  // Each spelling a browser or a hand-edited variable could carry that is not exactly one origin: refused, named.
  test('parsePublicOrigins refuses the odd spellings, each with its reason', () => {
    const odd = ['https:host', 'https:/host', 'https://:@host', 'https://desk.example.test/..', 'https://desk.example.test#', 'desk.example.test']
    expect(parsePublicOrigins(odd.join(',')).origins).toEqual([])
    expect(parsePublicOrigins(odd.join(',')).ignored).toHaveLength(odd.length)
    expect(parsePublicOrigins('https://desk.example.test.')).toEqual({ origins: [], ignored: ['https://desk.example.test. (a trailing dot)'] })
    expect(parsePublicOrigins('http://desk.example.test')).toEqual({ origins: [], ignored: ['http://desk.example.test (https only)'] })
  })

  test('parsePublicOrigins still accepts http on a loopback name', () => {
    expect(parsePublicOrigins('http://localhost:7795, http://127.0.0.1:7795').origins).toEqual([
      'http://localhost:7795',
      'http://127.0.0.1:7795',
    ])
  })

  // createServer takes the same canonical form: a bare host name must not make its suffix ('sk.example.test') trusted.
  test('the real server trusts only canonical origins it is given, never a bare host name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-public-bare-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-public-bare-plugins-'))
    temps.push(home, plugins)
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, publicOrigins: ['desk.example.test'] })
    servers.push(desk)
    expect((await fetch(`${desk.url}/api/health`, { headers: { host: 'sk.example.test' } })).status).toBe(403)
    expect((await fetch(`${desk.url}/api/health`, { headers: { host: 'desk.example.test' } })).status).toBe(403)
  })

  test('foreignRequest passes a listed host (any case) and origin, and refuses everything else', () => {
    for (const h of [PROXIED, { ...PROXIED, host: 'DESK.example.test' }, { host: 'desk.example.test' }]) {
      expect(foreignRequest(new Headers(h), TRUSTED)).toBeNull()
    }
    for (const h of REFUSE) expect(typeof foreignRequest(new Headers(h), TRUSTED)).toBe('string')
    for (const h of PASS) expect(foreignRequest(new Headers(h), TRUSTED)).toBeNull()
    expect(foreignRequest(new Headers({ host: 'desk.example.test:9999' }), TRUSTED)).toBeString()
    expect(foreignRequest(new Headers({ host: 'desk.example.test', origin: 'http://desk.example.test' }), TRUSTED)).toBeString()
    expect(foreignRequest(new Headers({ ...PROXIED, 'sec-fetch-site': 'cross-site' }), TRUSTED)).toBeString()
    expect(foreignRequest(new Headers({ host: 'desk.example.test', origin: 'null' }), TRUSTED)).toBeString()
  })

  test('the real server answers the listed name on every route and its websocket upgrade, and refuses the rest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-public-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-public-plugins-'))
    temps.push(home, plugins)
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, publicOrigins: TRUSTED })
    servers.push(desk)

    expect((await fetch(`${desk.url}/api/health`, { headers: PROXIED })).status).toBe(200)
    expect((await fetch(`${desk.url}/api/health`, { headers: { ...PROXIED, host: 'DESK.example.test' } })).status).toBe(200)
    // The /ws upgrade passes the guard (426 = not an upgrade), where a refused one is 403
    expect((await fetch(`${desk.url}/ws`, { headers: PROXIED })).status).toBe(426)

    const refused: Record<string, string>[] = [
      { host: 'evil.example', origin: 'https://evil.example' },
      { ...PROXIED, host: 'desk.example.test:9999' },
      { ...PROXIED, origin: 'http://desk.example.test' },
      { ...PROXIED, origin: 'https://evil.example' },
      { ...PROXIED, 'sec-fetch-site': 'cross-site' },
      { ...PROXIED, origin: 'null' },
    ]
    for (const h of refused) {
      expect((await fetch(`${desk.url}/api/health`, { headers: h })).status).toBe(403)
      expect((await fetch(`${desk.url}/ws`, { headers: h })).status).toBe(403)
    }
  })

  test('a sign-in redirect back to the listed name loads its page, and the rest of the list stays refused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-public-nav-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-public-nav-plugins-'))
    temps.push(home, plugins)
    // A plugin's own websocket route, outside Hono: it takes the same list as /ws does
    writeFileSync(join(plugins, '10-ws-test.ts'), "export default function plugin(_app: unknown, ctx: any) { ctx.wsRoute('/ws-test', { accept: () => new Response('ok') }) }\n")
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, publicOrigins: TRUSTED })
    servers.push(desk)

    // The page after the proxy's login: a top-level navigation, cross-site because the sign-in page started it
    expect((await fetch(`${desk.url}/`, { headers: NAVIGATION })).status).not.toBe(403)
    expect((await fetch(`${desk.url}/api/health`, { headers: NAVIGATION })).status).toBe(403)
    expect((await fetch(`${desk.url}/ws-test`, { headers: PROXIED })).status).toBe(200)
    expect((await fetch(`${desk.url}/ws-test`, { headers: { ...PROXIED, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await fetch(`${desk.url}/ws-test`, { headers: { host: '127.0.0.1:7795' } })).status).toBe(200)
  })
})

// A top-level page load of a listed host passes even though a sign-in redirect makes it cross-site (ruling, 2026-10-17).
// Everything else that is cross-site stays refused: loopback, /api, /ws, /oauth, a fetch, a POST, an Origin of null.
describe('listed page navigation', () => {
  const PUBLIC = 'https://desk.example.test'
  const TRUSTED = [PUBLIC]
  const NAVIGATION = { host: 'desk.example.test', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

  test('a GET or HEAD document navigation to a start page of a listed host passes', () => {
    for (const path of ['/', '/index.html', '/ah', '/ah/', '/ah/index.html']) {
      expect(foreignRequest(new Headers(NAVIGATION), TRUSTED, 'GET', path)).toBeNull()
      expect(foreignRequest(new Headers(NAVIGATION), TRUSTED, 'HEAD', path)).toBeNull()
    }
  })

  // The allow-list (ruling, 2026-10-17): any path that is not a start page is refused, including a route added later.
  test('a navigation to any other path of a listed host is refused', () => {
    for (const path of ['/chats/1', '/anything', '/assets/x.js', '/%61pi/tasks', '/ah/assets/x.js', '/ah/index.htm']) {
      expect(typeof foreignRequest(new Headers(NAVIGATION), TRUSTED, 'GET', path)).toBe('string')
    }
  })

  test('the neighbours of that navigation stay refused', () => {
    const refused: [Record<string, string>, string, string][] = [
      // a cross-site fetch to a listed host (cors, not a navigation)
      [{ ...NAVIGATION, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, 'GET', '/'],
      // a navigation to an API, websocket or OAuth path
      [NAVIGATION, 'GET', '/api/settings'],
      [NAVIGATION, 'GET', '/ws'],
      [NAVIGATION, 'GET', '/oauth/callback'],
      // a navigation to a route under another prefix: MCP, the /ah copy's API, the dev-servers API (the old list let these through)
      [NAVIGATION, 'GET', '/mcp/browser'],
      [NAVIGATION, 'GET', '/ah/api/x'],
      [NAVIGATION, 'GET', '/dw/api/x'],
      // a same-site navigation to an API path is refused too
      [{ ...NAVIGATION, 'sec-fetch-site': 'same-site' }, 'GET', '/api/tasks'],
      // a navigation to this machine (a cross-site link to 127.0.0.1 is refused today)
      [{ ...NAVIGATION, host: '127.0.0.1:7795' }, 'GET', '/'],
      // a cross-site POST, PUT or DELETE that is also a navigation
      [NAVIGATION, 'POST', '/'],
      [NAVIGATION, 'PUT', '/'],
      [NAVIGATION, 'DELETE', '/'],
      // an Origin of null, even on a navigation
      [{ ...NAVIGATION, origin: 'null' }, 'GET', '/'],
      // a navigation to a name that is not listed
      [{ ...NAVIGATION, host: 'evil.example' }, 'GET', '/'],
    ]
    for (const [h, method, path] of refused) {
      expect(typeof foreignRequest(new Headers(h), TRUSTED, method, path)).toBe('string')
    }
  })

  test('without a listed host the cross-site navigation is refused, as before', () => {
    expect(typeof foreignRequest(new Headers({ ...NAVIGATION, host: '127.0.0.1:7795' }), [], 'GET', '/')).toBe('string')
    expect(typeof foreignRequest(new Headers(NAVIGATION), [], 'GET', '/')).toBe('string')
  })
})

// The Origin follows the Host (ruling, 2026-10-17): a listed origin is no pass on a loopback Host, and a loopback
// Origin is no pass on a listed Host. On a loopback Host the Origin rule is origin/main's.
describe('the Origin follows the Host', () => {
  const PUBLIC = 'https://desk.example.test'
  const OTHER = 'https://blog.example.test'
  const TRUSTED = [PUBLIC, OTHER]

  test('a loopback Host with a listed Origin is refused, as origin/main refuses it', () => {
    for (const origin of [PUBLIC, OTHER]) {
      expect(typeof foreignRequest(new Headers({ host: '127.0.0.1:7795', origin }), TRUSTED, 'GET', '/api/x')).toBe('string')
      expect(typeof foreignRequest(new Headers({ host: 'localhost:7795', origin }), TRUSTED, 'GET', '/api/x')).toBe('string')
    }
  })

  test('a listed Host with a loopback Origin is refused', () => {
    for (const origin of ['http://127.0.0.1:7795', 'http://localhost:5173', 'http://[::1]:5173']) {
      expect(typeof foreignRequest(new Headers({ host: 'desk.example.test', origin }), TRUSTED, 'GET', '/api/x')).toBe('string')
    }
  })

  test('a listed Host passes its own listed Origin', () => {
    expect(foreignRequest(new Headers({ host: 'desk.example.test', origin: PUBLIC }), TRUSTED, 'GET', '/api/x')).toBeNull()
    expect(foreignRequest(new Headers({ host: 'blog.example.test', origin: OTHER }), TRUSTED, 'GET', '/api/x')).toBeNull()
  })

  test('a listed Host with another listed origin is refused', () => {
    expect(typeof foreignRequest(new Headers({ host: 'desk.example.test', origin: OTHER }), TRUSTED, 'GET', '/api/x')).toBe('string')
    expect(typeof foreignRequest(new Headers({ host: 'blog.example.test', origin: PUBLIC }), TRUSTED, 'GET', '/api/x')).toBe('string')
  })
})

// A sibling name (blog.example.test) is same-site with the listed name, so a same-site request must not reach the
// window: the old guard let through every same-site request, including an image, a frame and an API navigation.
describe('same-site requests to a listed host', () => {
  const PUBLIC = 'https://desk.example.test'
  const TRUSTED = [PUBLIC]
  const SAME_SITE = { host: 'desk.example.test', 'sec-fetch-site': 'same-site' }

  test('a no-cors image GET to an API path is refused', () => {
    const h = { ...SAME_SITE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }
    expect(typeof foreignRequest(new Headers(h), TRUSTED, 'GET', '/api/tasks')).toBe('string')
  })

  test('a same-site iframe of the window is refused', () => {
    const h = { ...SAME_SITE, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }
    expect(typeof foreignRequest(new Headers(h), TRUSTED, 'GET', '/')).toBe('string')
  })

  test('a same-site navigation to an API path is refused, but to the window it passes (the sign-in redirect)', () => {
    const nav = { ...SAME_SITE, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    expect(typeof foreignRequest(new Headers(nav), TRUSTED, 'GET', '/api/tasks')).toBe('string')
    expect(foreignRequest(new Headers(nav), TRUSTED, 'GET', '/')).toBeNull()
  })

  test('a same-origin GET, and a GET with no Sec-Fetch-Site, to an API path pass', () => {
    expect(foreignRequest(new Headers({ host: 'desk.example.test', origin: PUBLIC, 'sec-fetch-site': 'same-origin' }), TRUSTED, 'GET', '/api/x')).toBeNull()
    expect(foreignRequest(new Headers({ host: 'desk.example.test' }), TRUSTED, 'GET', '/api/x')).toBeNull()
  })

  test('loopback is unchanged: a same-site GET to an API path on 127.0.0.1 passes, listed or not', () => {
    const loopback = { host: '127.0.0.1:7795', 'sec-fetch-site': 'same-site' }
    expect(foreignRequest(new Headers(loopback), [], 'GET', '/api/x')).toBeNull()
    expect(foreignRequest(new Headers(loopback), TRUSTED, 'GET', '/api/x')).toBeNull()
  })

  test('the real server refuses a same-site image and frame, and answers the window to a same-site navigation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-public-same-site-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-public-same-site-plugins-'))
    temps.push(home, plugins)
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, publicOrigins: TRUSTED })
    servers.push(desk)
    const image = { ...SAME_SITE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }
    const frame = { ...SAME_SITE, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }
    const nav = { ...SAME_SITE, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    expect((await fetch(`${desk.url}/api/health`, { headers: image })).status).toBe(403)
    expect((await fetch(`${desk.url}/`, { headers: frame })).status).toBe(403)
    expect((await fetch(`${desk.url}/`, { headers: nav })).status).not.toBe(403)
  })
})

// The window's pages carry the framing and opener headers on a listed host only (ruling, 2026-10-17). Loopback is unchanged.
describe('framing headers', () => {
  const PUBLIC = 'https://desk.example.test'
  const FRAMING = {
    'content-security-policy': "frame-ancestors 'self'",
    'x-frame-options': 'SAMEORIGIN',
    'cross-origin-opener-policy': 'same-origin',
  }

  test('a listed host gets the framing and opener headers on the API and the window', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-framing-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-framing-plugins-'))
    temps.push(home, plugins)
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, publicOrigins: [PUBLIC] })
    servers.push(desk)
    const proxied = { host: 'desk.example.test', origin: PUBLIC, 'sec-fetch-site': 'same-origin' }
    for (const path of ['/api/health', '/']) {
      const res = await fetch(`${desk.url}${path}`, { headers: proxied })
      for (const [name, value] of Object.entries(FRAMING)) expect(res.headers.get(name)).toBe(value)
    }
  })

  test('loopback sends none of the framing or opener headers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-framing-loop-home-'))
    const plugins = mkdtempSync(join(tmpdir(), 'desk-framing-loop-plugins-'))
    temps.push(home, plugins)
    const desk = await createServer({ port: 0, home, pluginsDir: plugins, publicOrigins: [PUBLIC] })
    servers.push(desk)
    const res = await fetch(`${desk.url}/api/health`)
    for (const name of Object.keys(FRAMING)) expect(res.headers.get(name)).toBeNull()
  })
})

// server/tests/api-guard-order.test.ts - the /api/* guard must be mounted before any route registers.
//
// Hono runs handlers in registration order, and index.ts mounts the loopback guard (cors, the Origin/Host
// check, the body limit) on /api/* only after its static imports have loaded. kit/sweep.ts is one of those
// imports, and it loads kit/ingest-claude.ts, which imported routes/hswarm.ts for hswarmAccountId. So the
// HSwarm routes were registered first: a page on another origin got 200 from GET /api/hswarm-status, and
// /api/hswarm/* was forwarded to HSwarm with its console token added.
//
// Three claims pin that down:
//   (a) loading the static imports of index.ts and daemon-preboot.ts registers no route on the shared app,
//       so any future early registration fails here, not only HSwarm's.
//   (b) with the guard mounted first, as index.ts mounts it, the HSwarm routes refuse a foreign Origin and a
//       foreign Host with the guard's 403 and the sidecar sees nothing. A request with no browser headers
//       still reaches the sidecar (the control), so the 403s are the guard's and not a dead route.
// Both run in child processes so the shared Hono app and the module cache start empty. index.ts is not
// imported: its body starts the daemon, so its static imports are loaded one at a time instead.
import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = join(import.meta.dir, '..', 'src')
const scratch = mkdtempSync(join(tmpdir(), 'api-guard-order-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Code modules only: a plain .js file is imported as text (dashboards.ts `with { type: 'text' }`), never run. */
function resolveModule(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.mjs`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.js')) continue
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** The files under server/src that the entry files import statically (import(), the dynamic form, is left out). */
function staticClosure(entries: string[]): string[] {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    const transpiler = new Bun.Transpiler({ loader: file.endsWith('.ts') ? 'ts' : 'js' })
    for (const imp of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (imp.kind === 'dynamic-import' || !imp.path.startsWith('.')) continue
      const target = resolveModule(join(dirname(file), imp.path))
      if (target?.startsWith(SRC)) queue.push(target)
    }
  }
  return [...seen]
}

/** The text of the child's stdout line that starts with `marker`; the child's own logging may come first. */
async function runChild(script: string, marker: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  const line = out.split('\n').find((l) => l.startsWith(marker))
  if (line === undefined)
    throw new Error(`child printed no ${marker} line; stderr:\n${err.slice(-2000)}`)
  return JSON.parse(line.slice(marker.length))
}

const url = (file: string) => pathToFileURL(join(SRC, file)).href

test('loading the static imports of index.ts and daemon-preboot.ts registers no route', async () => {
  const indexFile = join(SRC, 'index.ts')
  const modules = staticClosure([indexFile, join(SRC, 'daemon-preboot.ts')]).filter(
    (f) => f !== indexFile,
  )
  // The walk must reach the daemon's graph, or the empty result below proves nothing.
  expect(modules.length).toBeGreaterThan(50)

  const script = [
    `for (const f of ${JSON.stringify(modules.map((f) => pathToFileURL(f).href))}) await import(f)`,
    `const { app } = await import(${JSON.stringify(url('http-app.ts'))})`,
    'console.log("ROUTES " + JSON.stringify(app.routes.map((r) => r.method + " " + r.path)))',
    'process.exit(0)',
  ].join('\n')

  expect(await runChild(script, 'ROUTES ', { HSWARM_HOME: join(scratch, 'hswarm-home') })).toEqual(
    [],
  )
}, 120_000)

test('with the guard mounted first, the HSwarm routes refuse foreign browsers and reach the sidecar only for others', async () => {
  const pkg = join(scratch, 'hswarm-pkg')
  mkdirSync(join(pkg, 'hswarm'), { recursive: true })
  writeFileSync(join(pkg, 'hswarm', '__init__.py'), '')

  const script = [
    `const { createLoopbackGuard } = await import(${JSON.stringify(url('loopback-guard.mjs'))})`,
    `const { apiOriginAllowlist } = await import(${JSON.stringify(url('api-origins.ts'))})`,
    `const { app } = await import(${JSON.stringify(url('http-app.ts'))})`,
    `const { getHSwarmStatus, startHSwarm } = await import(${JSON.stringify(url('hswarm.ts'))})`,
    // The fake HSwarm: counts what the proxy forwards to it.
    'let hits = 0',
    "const sidecar = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { hits++; return Response.json({ ok: true }) } })",
    // index.ts's order: the guard first, then the route modules.
    "app.use('/api/*', createLoopbackGuard({ allowedOrigins: () => apiOriginAllowlist('http://127.0.0.1:7787', {}) }))",
    `await import(${JSON.stringify(url('routes/hswarm.ts'))})`,
    // A side-run daemon adopts the running sidecar on its port and never spawns one.
    `await startHSwarm({ enabled: true, dir: ${JSON.stringify(pkg)}, logDir: ${JSON.stringify(join(scratch, 'logs'))}, probe: async () => ({ hswarm: true, pid: 4242, package: ${JSON.stringify(pkg)} }), kill: () => {}, spawn: () => { throw new Error('a side-run daemon must not spawn') }, port: sidecar.port, sideRun: true })`,
    'const cases = [',
    "  { name: 'foreign Origin: status', path: '/api/hswarm-status', headers: { origin: 'http://evil.example' } },",
    "  { name: 'foreign Origin: accounts', path: '/api/hswarm-accounts', headers: { origin: 'http://evil.example' } },",
    "  { name: 'foreign Origin: proxy POST', method: 'POST', path: '/api/hswarm/api/jobs', body: '{}', headers: { origin: 'http://evil.example', 'content-type': 'application/json' } },",
    "  { name: 'foreign Host: proxy', path: '/api/hswarm/api/stats', headers: { host: 'evil.example' } },",
    "  { name: 'control: no browser headers', path: '/api/hswarm/api/stats', headers: {} },",
    ']',
    'const results = []',
    'for (const c of cases) {',
    '  const before = hits',
    '  const res = await app.request(c.path, { method: c.method ?? "GET", headers: c.headers, body: c.body })',
    '  results.push({ name: c.name, status: res.status, reached: hits - before })',
    '}',
    'const { running, port } = getHSwarmStatus()',
    'console.log("RESULT " + JSON.stringify({ results, running, adopted: port === sidecar.port }))',
    'process.exit(0)',
  ].join('\n')

  const { results, running, adopted } = await runChild(script, 'RESULT ', {
    HSWARM_HOME: join(scratch, 'hswarm-home'),
  })
  // The sidecar must really be wired in, or the 403s below could come from a dead route.
  expect({ running, adopted }).toEqual({ running: true, adopted: true })

  const byName = Object.fromEntries(
    (results as Array<{ name: string; status: number; reached: number }>).map((r) => [r.name, r]),
  )
  for (const name of [
    'foreign Origin: status',
    'foreign Origin: accounts',
    'foreign Origin: proxy POST',
    'foreign Host: proxy',
  ]) {
    expect(byName[name]).toEqual({ name, status: 403, reached: 0 })
  }
  // Control: a request with no browser headers goes through, and reaches the sidecar.
  expect(byName['control: no browser headers']).toEqual({
    name: 'control: no browser headers',
    status: 200,
    reached: 1,
  })
}, 120_000)

// (c) index.ts itself: its body is not imported above, so its text is read. No route may be
// registered on the shared app before the /api guard mount. app.use middleware above it is fine
// (cors, the body limit and the stall sentinel are mounted first on purpose).
test('index.ts registers no route on the shared app above the /api guard', () => {
  const lines = readFileSync(join(SRC, 'index.ts'), 'utf8').split('\n')
  const guard = lines.findIndex((l) => l.includes("app.use('/api/*', createLoopbackGuard("))
  expect(guard).toBeGreaterThan(0)
  const ROUTE = /\bapp\.(get|post|put|patch|delete|all|on|route)\(/
  const early = lines
    .slice(0, guard)
    .flatMap((l, i) => (ROUTE.test(l) ? [`line ${i + 1}: ${l.trim()}`] : []))
  expect(early).toEqual([])
})

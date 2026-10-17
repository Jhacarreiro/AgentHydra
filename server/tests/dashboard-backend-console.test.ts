import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDashboardBackend, stopDashboardBackend } from '../src/dashboard-backend'

const root = mkdtempSync(join(tmpdir(), 'dashboard-backend-console-'))

// A console program the backend starts the plain way (no flags), as a venv's python.exe launcher starts the real
// python: it prints the window of the console it got, 0 when that console has none.
const probe = join(root, 'probe.ts')
writeFileSync(
  probe,
  `import { dlopen, FFIType } from 'bun:ffi'
const k = dlopen('kernel32.dll', { GetConsoleWindow: { args: [], returns: FFIType.ptr } })
console.log(String(k.symbols.GetConsoleWindow() ?? 0))
`,
)
const backendScript = join(root, 'backend.ts')
writeFileSync(
  backendScript,
  `console.log('backend says hello')
const port = Number(process.argv[2])
Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/api/ping') return Response.json({ ok: true })
    if (u.pathname === '/api/console') {
      const child = Bun.spawn([process.execPath, ${JSON.stringify(probe)}], { stdout: 'pipe', stderr: 'ignore' })
      return Response.json({ window: (await new Response(child.stdout).text()).trim() })
    }
    return new Response('no such route', { status: 404 })
  },
})
`,
)

function freePort(): number {
  const probeServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const p = probeServer.port as number
  probeServer.stop(true)
  return p
}

const started: string[] = []
async function startBackend(id: string): Promise<{ port: number; log: string }> {
  const port = freePort()
  const log = join(root, `${id}.log`)
  started.push(id)
  const problem = await ensureDashboardBackend(
    id,
    {
      command: [process.execPath, backendScript, String(port)],
      cwd: root,
      port,
      health: '/api/ping',
    },
    log,
  )
  expect(problem).toBeNull()
  return { port, log }
}

afterAll(async () => {
  for (const id of started) stopDashboardBackend(id)
  // A killed backend lets go of its folder a moment after the kill.
  for (let tries = 1; ; tries++) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (err) {
      if (tries >= 50) throw err
      await Bun.sleep(100)
    }
  }
})

test.skipIf(process.platform !== 'win32')(
  'a console program the backend starts gets no console window (Windows Terminal opened one for each)',
  async () => {
    const { port } = await startBackend('console-window')
    const res = await fetch(`http://127.0.0.1:${port}/api/console`)
    expect(((await res.json()) as { window: string }).window).toBe('0')
  },
  40_000,
)

test('what the backend prints reaches backend.log', async () => {
  const { log } = await startBackend('log')
  const deadline = Date.now() + 5000
  let text = ''
  while (Date.now() < deadline) {
    text = readFileSync(log, 'utf8')
    if (text.includes('backend says hello')) break
    await Bun.sleep(100)
  }
  expect(text).toContain('starting ')
  expect(text).toContain('backend says hello')
}, 40_000)

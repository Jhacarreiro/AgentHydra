import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DashboardError,
  dashboardId,
  serveDashboardSite,
  workspaceOf,
  writeDashboard,
} from '../src/dashboards'
import { findEngine, fourmanBoard, fourmanStatus, runEngine } from '../src/fourman'
import { app } from '../src/http-app'
import '../src/routes/fourman'

const scratch = mkdtempSync(join(tmpdir(), 'fourman-test-'))
const engine = join(scratch, 'fake-4man.mjs')
const logPath = join(scratch, 'engine-runs.log')

writeFileSync(
  engine,
  `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const at = args.indexOf('--folder')
const scope = at >= 0 ? args[at + 1] : args.includes('--all') ? 'all' : args[args.indexOf('--project') + 1]
if (process.env.FAKE_4MAN_LOG) appendFileSync(process.env.FAKE_4MAN_LOG, scope + '\\n')
const base = String(scope).replace(/\\\\/g, '/').split('/').pop()
if (base === 'slow') setTimeout(() => {}, 60000)
else {
  const task = (n, body) => ({
    id: 't' + n, title: 'Task ' + n, body, project: base, status: 'ready', tier: 'A', quadrant: 'Q1',
    type: 'build', size: 'S', impact: 'high', live: false, risky: false, needsHuman: false,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', tierWhy: 'example',
    cwd: 'C:/Users/me/Example', secret: 'not copied',
  })
  const ready = base === 'big'
    ? Array.from({ length: 250 }, (_, n) => task(n, 'b'))
    : [task(1, 'x'.repeat(700)), task(2, 'short')]
  process.stdout.write(JSON.stringify({ project: base, ready, readyCount: ready.length, human: [task(3, 'h')], claimed: [], pending: [], directions: [] }))
}
`,
)

const savedEnv = {
  AGENTHYDRA_FOURMAN: process.env.AGENTHYDRA_FOURMAN,
  FAKE_4MAN_LOG: process.env.FAKE_4MAN_LOG,
}

beforeAll(() => {
  process.env.AGENTHYDRA_FOURMAN = engine
  process.env.FAKE_4MAN_LOG = logPath
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

describe('discovery', () => {
  test('no engine means not installed', () => {
    const emptyHome = join(scratch, 'empty-home')
    mkdirSync(emptyHome, { recursive: true })
    expect(findEngine({}, emptyHome)).toBeNull()
    process.env.AGENTHYDRA_FOURMAN = join(scratch, 'missing', '4man.mjs')
    const status = fourmanStatus()
    process.env.AGENTHYDRA_FOURMAN = engine
    expect(status.available).toBe(false)
    expect(status.notes.available).toBe(false)
  })

  test('the env variable names the engine', () => {
    expect(findEngine({ AGENTHYDRA_FOURMAN: engine }, join(scratch, 'none'))).toEqual({
      path: engine,
      via: 'env',
    })
  })

  test('the Connections local MCP entry in ~/.claude.json gives the checkout', () => {
    const checkout = join(scratch, 'Connections')
    const home = join(scratch, 'config-home')
    const found = join(checkout, 'tools', '4man', '4man.mjs')
    mkdirSync(join(checkout, 'tools', '4man'), { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(found, '')
    const server = join(checkout, 'services', 'studio', 'local-mcp', 'src', 'index.mjs')
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          other: { command: 'node', args: ['C:/Example/other.mjs'] },
          connections: { command: 'node', args: [server] },
        },
      }),
    )
    expect(findEngine({}, home)).toEqual({ path: found, via: 'claude-config' })
  })
})

describe('the board', () => {
  test('a fake engine answer is trimmed, and body is cut to 600 characters', async () => {
    const board = await fourmanBoard({ folder: 'C:/Users/me/Example' })
    expect(board.available).toBe(true)
    expect(board.project).toBe('Example')
    expect(board.readyCount).toBe(2)
    expect(board.ready[0]?.body.length).toBe(600)
    expect(board.ready[1]?.body).toBe('short')
    expect(board.human.length).toBe(1)
    expect(board.notes).toEqual([])
    const keys = Object.keys(board.ready[0] ?? {}).sort()
    expect(keys).not.toContain('cwd')
    expect(keys).not.toContain('secret')
    expect(keys).toContain('tierWhy')
  })

  test('each list is capped at 200 and readyCount is the engine total', async () => {
    const board = await fourmanBoard({ folder: 'C:/Users/me/big' })
    expect(board.ready.length).toBe(200)
    expect(board.readyCount).toBe(250)
  })

  test('one engine run serves repeat requests inside the cache window', async () => {
    await fourmanBoard({ folder: 'C:/Users/me/cached' })
    await fourmanBoard({ folder: 'C:/Users/me/cached' })
    const runs = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.endsWith('/cached'))
    expect(runs.length).toBe(1)
  })

  test('an engine that does not answer in time is refused', async () => {
    await expect(runEngine(engine, ['list', '--folder', 'C:/Users/me/slow'], 300)).rejects.toThrow(
      /did not answer/,
    )
  })

  test('a missing engine answers available:false', async () => {
    process.env.AGENTHYDRA_FOURMAN = join(scratch, 'gone', '4man.mjs')
    const board = await fourmanBoard({ all: true })
    process.env.AGENTHYDRA_FOURMAN = engine
    expect(board.available).toBe(false)
    expect(board.ready).toEqual([])
    expect(board.notes).toEqual([])
  })
})

describe('routes', () => {
  test('the board needs a cwd, a project or all=1', async () => {
    const res = await app.fetch(new Request('http://127.0.0.1/api/fourman/board'))
    expect(res.status).toBe(400)
  })

  test('a relative cwd is refused', async () => {
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/fourman/board?cwd=relative/folder'),
    )
    expect(res.status).toBe(400)
  })

  test('GET /api/fourman reports the engine and the notes status', async () => {
    const res = await app.fetch(new Request('http://127.0.0.1/api/fourman'))
    const body = (await res.json()) as { available: boolean; notes: { available: boolean } }
    expect(body.available).toBe(true)
    expect(body.notes.available).toBe(false)
  })
})

describe('dashboard origin', () => {
  const workspace = join(scratch, 'feed-project')
  mkdirSync(join(workspace, '.git'), { recursive: true })

  test('/_hydra/todo.json answers the dashboard folder board', async () => {
    await writeDashboard(workspace, { files: [{ path: 'index.html', content: '<p>x</p>' }] })
    const host = `${dashboardId(workspaceOf(workspace))}.localhost:7777`
    const res = await serveDashboardSite(
      new Request(`http://${host}/_hydra/todo.json`, { headers: { host } }),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as { available: boolean; project: string; ready: unknown[] }
    expect(body.available).toBe(true)
    expect(body.project).toBe('feed-project')
    expect(body.ready.length).toBe(2)
  })

  test('/_hydra/todo.js is the widget script', async () => {
    const host = `${dashboardId(workspaceOf(workspace))}.localhost:7777`
    const res = await serveDashboardSite(
      new Request(`http://${host}/_hydra/todo.js`, { headers: { host } }),
    )
    expect(res?.headers.get('content-type')).toContain('javascript')
    expect(await res?.text()).toContain('data-hydra-todo')
  })

  test('writes under _hydra/ are refused in every form', async () => {
    const refused = [
      { files: [{ path: '_hydra/todo.json', content: '{}' }] },
      { files: [{ path: '_Hydra/x.js', content: '' }] },
      { edits: [{ path: '_hydra/todo.js', old: 'a', new: 'b' }] },
      { remove: ['_hydra/todo.js'] },
    ]
    for (const change of refused) {
      await expect(writeDashboard(workspace, change)).rejects.toBeInstanceOf(DashboardError)
    }
  })
})

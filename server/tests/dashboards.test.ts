import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DashboardError,
  listDashboards,
  MAX_WIDGETS,
  readDashboard,
  writeDashboard,
} from '../src/dashboards'
import { app } from '../src/http-app'
import '../src/routes/dashboards'
import { TOOLS } from '../src/mcp'
import { resetDaemonResolutionForTests, useOwnDaemon } from '../src/mcp-client'
import { withDeskChat } from '../src/mcp-find'

const root = mkdtempSync(join(tmpdir(), 'dashboards-test-'))
const project = join(root, 'project')
const inside = join(project, 'src', 'deep')
const plain = join(root, 'plain')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(inside, { recursive: true })
mkdirSync(plain, { recursive: true })

const stat = (id: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'stat',
  title: `Stat ${id}`,
  value,
  ...extra,
})

const saved: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let daemon: ReturnType<typeof Bun.serve>
let desk: ReturnType<typeof Bun.serve>

beforeAll(() => {
  daemon = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch })
  desk = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json([{ id: 'chat-1', title: 'Example chat', cwd: inside }]),
  })
  useOwnDaemon(`http://127.0.0.1:${daemon.port}`)
  setEnv('HYDRA_DESK_PORT', String(desk.port))
  setEnv('HYDRA_DESK_CHAT_ID', 'chat-1')
})

afterAll(() => {
  daemon.stop(true)
  desk.stop(true)
  resetDaemonResolutionForTests()
  for (const [key, value] of Object.entries(saved)) setEnv(key, value)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('the store keys a dashboard by its checkout', () => {
  test('a folder inside the project reads and writes the checkout dashboard', async () => {
    await writeDashboard(project, { put: [stat('open-prs', 3)], by: 'Example owner' })
    const fromInside = await readDashboard(inside)
    expect(fromInside.widgets.map((w) => w.id)).toEqual(['open-prs'])
    expect(fromInside.workspace).toBe((await readDashboard(project)).workspace)
  })

  test('a folder with no checkout is its own workspace', async () => {
    await writeDashboard(plain, { put: [stat('solo', 1)] })
    expect((await readDashboard(plain)).widgets).toHaveLength(1)
    expect((await readDashboard(project)).widgets.map((w) => w.id)).toEqual(['open-prs'])
  })

  test('a folder that does not exist is refused', async () => {
    await expect(readDashboard(join(root, 'missing'))).rejects.toBeInstanceOf(DashboardError)
  })

  test('listDashboards names each workspace that has widgets', async () => {
    const list = await listDashboards()
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.some((d) => d.widgets >= 1)).toBe(true)
  })
})

describe('put, remove, clear and order', () => {
  const fresh = join(root, 'fresh')
  mkdirSync(fresh, { recursive: true })

  test('writing the same id replaces that widget', async () => {
    await writeDashboard(fresh, { put: [stat('a', 1)] })
    const after = await writeDashboard(fresh, { put: [stat('a', 2)] })
    expect(after.widgets).toHaveLength(1)
    expect(after.widgets[0]?.value).toBe(2)
  })

  test('remove deletes the named widgets', async () => {
    await writeDashboard(fresh, { put: [stat('b', 1), stat('c', 1)] })
    const after = await writeDashboard(fresh, { remove: ['b'] })
    expect(after.widgets.map((w) => w.id).sort()).toEqual(['a', 'c'])
  })

  test('clear removes every widget before the put lands', async () => {
    const after = await writeDashboard(fresh, { clear: true, put: [stat('only', 9)] })
    expect(after.widgets.map((w) => w.id)).toEqual(['only'])
  })

  test('widgets with an order come first, lowest first, the rest oldest first', async () => {
    const ordered = join(root, 'ordered')
    mkdirSync(ordered, { recursive: true })
    await writeDashboard(ordered, { put: [stat('free', 1)] })
    await writeDashboard(ordered, {
      put: [stat('second', 1, { order: 2 }), stat('first', 1, { order: 1 })],
    })
    const after = await readDashboard(ordered)
    expect(after.widgets.map((w) => w.id)).toEqual(['first', 'second', 'free'])
  })

  test('the default size is small for stat and wide for a list', async () => {
    const sized = join(root, 'sized')
    mkdirSync(sized, { recursive: true })
    const after = await writeDashboard(sized, {
      put: [stat('n', 1), { id: 'todo', kind: 'list', title: 'Todo', items: [{ text: 'Ship' }] }],
    })
    expect(after.widgets.find((w) => w.id === 'n')?.size).toBe('small')
    expect(after.widgets.find((w) => w.id === 'todo')?.size).toBe('wide')
  })
})

describe('refusals', () => {
  const folder = join(root, 'refusals')
  mkdirSync(folder, { recursive: true })
  const refused = [
    ['a bad id', { put: [stat('Bad Id', 1)] }],
    ['an unknown kind', { put: [{ id: 'x', kind: 'pie', title: 'X' }] }],
    ['a stat with no value', { put: [{ id: 'x', kind: 'stat', title: 'X' }] }],
    ['a list with no items', { put: [{ id: 'x', kind: 'list', title: 'X' }] }],
    ['a progress with no max', { put: [{ id: 'x', kind: 'progress', title: 'X', current: 1 }] }],
    [
      'a javascript link',
      {
        put: [
          {
            id: 'x',
            kind: 'list',
            title: 'X',
            items: [{ text: 'a', href: 'javascript:alert(1)' }],
          },
        ],
      },
    ],
    [
      'a note over 8000 characters',
      { put: [{ id: 'x', kind: 'note', title: 'X', text: 'a'.repeat(8001) }] },
    ],
    [
      'a chart with five series',
      {
        put: [
          {
            id: 'x',
            kind: 'chart',
            title: 'X',
            series: Array.from({ length: 5 }, () => ({ points: [1] })),
          },
        ],
      },
    ],
    ['a change that is not an object', 'nope'],
    ['a remove that is not a list of ids', { remove: 'a' }],
  ] as const

  for (const [label, change] of refused) {
    test(`refuses ${label}`, async () => {
      await expect(writeDashboard(folder, change)).rejects.toBeInstanceOf(DashboardError)
    })
  }

  test('a workspace holds at most 40 widgets, and an existing id still replaces', async () => {
    const full = join(root, 'full')
    mkdirSync(full, { recursive: true })
    const forty = Array.from({ length: MAX_WIDGETS }, (_, i) => stat(`w${i + 1}`, i))
    await writeDashboard(full, { put: forty })
    await expect(writeDashboard(full, { put: [stat('w41', 0)] })).rejects.toBeInstanceOf(
      DashboardError,
    )
    const replaced = await writeDashboard(full, { put: [stat('w1', 99)] })
    expect(replaced.widgets).toHaveLength(MAX_WIDGETS)
    expect(replaced.widgets.find((w) => w.id === 'w1')?.value).toBe(99)
  })
})

describe('concurrent writers', () => {
  test('two writes at once both land', async () => {
    const shared = join(root, 'shared')
    mkdirSync(shared, { recursive: true })
    await Promise.all([
      writeDashboard(shared, { put: [stat('left', 1)] }),
      writeDashboard(shared, { put: [stat('right', 2)] }),
    ])
    expect((await readDashboard(shared)).widgets.map((w) => w.id).sort()).toEqual(['left', 'right'])
  })
})

describe('REST routes', () => {
  test('GET /api/dashboards/workspace answers with the dashboard', async () => {
    const res = await app.request(`/api/dashboards/workspace?cwd=${encodeURIComponent(inside)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { widgets: { id: string }[] }
    expect(body.widgets.map((w) => w.id)).toEqual(['open-prs'])
  })

  test('GET /api/dashboards/workspace without cwd is a 400', async () => {
    const res = await app.request('/api/dashboards/workspace')
    expect(res.status).toBe(400)
  })

  test('POST /api/dashboards/workspace writes a widget', async () => {
    const res = await app.request('/api/dashboards/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: project, put: [stat('via-rest', 5)], by: 'Example owner' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { widgets: { id: string; updatedBy?: string }[] }
    expect(body.widgets.find((w) => w.id === 'via-rest')?.updatedBy).toBe('Example owner')
  })

  test('POST with a refused widget is a 400 with an error message', async () => {
    const res = await app.request('/api/dashboards/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: project, put: [stat('Bad Id', 1)] }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0)
  })
})

describe('the MCP tools', () => {
  const tools = withDeskChat(TOOLS, 'chat-1')
  const tool = (name: string) => tools.find((t) => t.name === name)!

  test('dashboard_write with no cwd writes the calling chat folder, by its title', async () => {
    const answer = (await tool('dashboard_write').run({
      put: [stat('mcp-widget', 7, { unit: '%' })],
    })) as { widgets: { id: string; updatedBy?: string }[] }
    const widget = answer.widgets.find((w) => w.id === 'mcp-widget')
    expect(widget?.updatedBy).toBe('Example chat')
  })

  test('dashboard_read with no cwd reads the calling chat folder', async () => {
    const answer = (await tool('dashboard_read').run({})) as { widgets: { id: string }[] }
    expect(answer.widgets.map((w) => w.id)).toContain('mcp-widget')
  })

  test('dashboard_write refuses a by longer than 60 characters', async () => {
    await expect(
      tool('dashboard_write').run({ cwd: project, by: 'x'.repeat(61), put: [stat('x', 1)] }),
    ).rejects.toThrow('by is over 60 characters')
  })

  test('with no folder and no Desk chat known, the tool says so', async () => {
    setEnv('HYDRA_DESK_CHAT_ID', undefined)
    setEnv('HYDRA_DESK_PORT', '1')
    try {
      await expect(tool('dashboard_read').run({})).rejects.toThrow('no folder to use')
    } finally {
      setEnv('HYDRA_DESK_PORT', String(desk.port))
      setEnv('HYDRA_DESK_CHAT_ID', 'chat-1')
    }
  })
})

// A project's template dashboard through Desk's own route, end to end: the spec in a checkout, an HTTP endpoint and an
// MCP server (named in a Claude config, spoken to over Streamable HTTP) as its sources, the page's answer filled from
// them, and the last good answer kept through a failed read and a restart. Fakes stand in only for the two providers.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProjectDashboard, ProjectDashboardList } from '@shared/project-dashboard'
import { createServer, type DeskServer } from '../../src/index'

const PLUGIN = join(import.meta.dir, '..', '..', 'src', 'plugins', '47-project-dashboard.ts')
const temps: string[] = []
const stops: (() => unknown)[] = []
const saved = { home: process.env.HYDRA_DESK_HOME, cfg: process.env.HYDRA_DESK_MAIN_CLAUDE_JSON }

const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of [['HYDRA_DESK_HOME', saved.home], ['HYDRA_DESK_MAIN_CLAUDE_JSON', saved.cfg]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** An HTTP endpoint answering a list feed, and an MCP server whose `dashboard` tool answers a ranged stats feed wrapped in prose. */
function providers() {
  const state = { feedReads: 0, failing: false, toolCalls: [] as unknown[] }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/feed') {
        state.feedReads++
        if (state.failing) return new Response('down', { status: 503 })
        return Response.json({
          format: 'agenthydra-dashboard/1',
          generatedAt: '2026-10-17T09:00:00Z',
          everyMinutes: 30,
          sections: {
            todo: { items: [{ title: 'Approve the ad budget', since: '2026-10-10T08:00:00Z' }], total: 1 },
            sources: { rows: [{ label: 'example.com', value: '7' }] }
          }
        })
      }
      if (url.pathname === '/mcp' && req.method === 'POST') {
        const msg = (await req.json()) as { id?: number; method: string; params?: { name: string; arguments: unknown } }
        if (msg.id === undefined) return new Response(null, { status: 202 })
        if (msg.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, { headers: { 'mcp-session-id': 'sess-1' } })
        state.toolCalls.push(msg.params)
        const feed = { sections: { hero: { ranges: { today: { tiles: [{ label: 'Visitors', value: 40, change: 12.5 }] }, '7d': { tiles: [{ label: 'Visitors', value: 638 }] } } } } }
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Here is the dashboard:\n${JSON.stringify(feed)}` }, { type: 'text', text: 'a footer line' }] } })
      }
      return new Response(null, { status: 404 })
    }
  })
  stops.push(() => server.stop(true))
  return { state, base: `http://127.0.0.1:${server.port}` }
}

function project(base: string): string {
  const root = temp('desk-dash-proj-')
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, '.agenthydra'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  writeFileSync(
    join(root, '.agenthydra', 'dashboard.json'),
    JSON.stringify({
      title: 'Atlas',
      refreshMinutes: 5,
      sources: { tool: { mcp: { server: 'example-mcp', tool: 'dashboard', arguments: { range: 'all' } } }, api: { http: { url: `${base}/feed` } } },
      sections: [
        { id: 'hero', type: 'stats', title: 'Numbers', source: 'tool' },
        { id: 'todo', type: 'list', title: 'Waiting on you', source: 'api', attention: true },
        { id: 'sources', type: 'breakdown', title: 'Where signups came from', source: 'api' },
        { id: 'errors', type: 'errors', title: 'Errors this week', source: 'api' }
      ]
    })
  )
  return root
}

async function desk(home: string, folders: string[]): Promise<DeskServer> {
  const plugins = temp('desk-dash-plugins-')
  writeFileSync(join(plugins, '47-project-dashboard.ts'), `export { default } from ${JSON.stringify(pathToFileURL(PLUGIN).href)}\n`)
  const server = await createServer({ port: 0, home, pluginsDir: plugins, deps: { projectFolders: async () => folders } })
  stops.push(() => server.stop())
  return server
}

test('a spec fills from an MCP tool and an HTTP endpoint, each section checked against its type; a folder with no spec answers 404', async () => {
  const p = providers()
  const root = project(p.base)
  const config = join(temp('desk-dash-cfg-'), '.claude.json')
  writeFileSync(config, JSON.stringify({ mcpServers: { 'example-mcp': { type: 'http', url: `${p.base}/mcp` } } }))
  process.env.HYDRA_DESK_MAIN_CLAUDE_JSON = config
  const home = temp('desk-dash-home-')
  const plain = temp('desk-dash-plain-')
  const server = await desk(home, [join(root, 'src'), plain])

  const d = (await (await fetch(`${server.url}/api/project-dashboard?cwd=${encodeURIComponent(join(root, 'src', 'deep'))}&wait=10000`)).json()) as ProjectDashboard
  expect(d.title).toBe('Atlas')
  expect(d.ranges).toEqual(['today', '7d'])
  expect(p.state.toolCalls).toEqual([{ name: 'dashboard', arguments: { range: 'all' } }])
  const byId = Object.fromEntries(d.sections.map((s) => [s.id, s]))
  expect(byId.hero.feed).toEqual({ ranges: { today: { tiles: [{ label: 'Visitors', value: 40, change: 12.5 }] }, '7d': { tiles: [{ label: 'Visitors', value: 638 }] } } })
  expect(byId.todo).toMatchObject({ icon: 'list', show: 5, attention: true, missing: null, feed: { items: [{ title: 'Approve the ad budget', since: '2026-10-10T08:00:00Z' }], total: 1 } })
  // A count sent as text cannot draw; the section says which value and why, and the page keeps the rest.
  expect(byId.sources.feed).toEqual({ rows: [] })
  expect(d.problems).toEqual([`HTTP 127.0.0.1:${new URL(p.base).port}: sections.sources.rows[0].value must be a number`])
  expect(byId.errors).toMatchObject({ feed: null, missing: `HTTP 127.0.0.1:${new URL(p.base).port} has no errors in its answer` })
  expect(d.sources.map((s) => [s.id, s.generatedAt, s.everyMinutes, s.error])).toEqual([
    ['tool', null, null, null],
    ['api', '2026-10-17T09:00:00Z', 30, null]
  ])

  const list = (await (await fetch(`${server.url}/api/project-dashboards`)).json()) as ProjectDashboardList
  expect(list.dashboards).toEqual([{ workspace: root.replace(/\\/g, '/'), title: 'Atlas' }])
  const none = await fetch(`${server.url}/api/project-dashboard?cwd=${encodeURIComponent(plain)}`)
  expect(none.status).toBe(404)
  expect(((await none.json()) as { spec: boolean }).spec).toBe(false)
})

test('a source is read once per refreshMinutes; its last good answer outlives a failed read and a restart', async () => {
  const p = providers()
  const root = project(p.base)
  process.env.HYDRA_DESK_MAIN_CLAUDE_JSON = join(temp('desk-dash-cfg-'), 'none.json')
  const home = temp('desk-dash-home-')
  const first = await desk(home, [root])
  const get = async (s: DeskServer) => (await (await fetch(`${s.url}/api/project-dashboard?cwd=${encodeURIComponent(root)}&wait=10000`)).json()) as ProjectDashboard

  await get(first)
  const again = await get(first)
  expect(p.state.feedReads).toBe(1)
  // The MCP server is in no config here: that source says so, and the other source's sections still draw.
  expect(again.sections.find((s) => s.id === 'hero')?.missing).toBe('Could not read MCP example-mcp · dashboard: no MCP server named example-mcp in your Claude config')

  p.state.failing = true
  const refreshed = (await (await fetch(`${first.url}/api/project-dashboard/refresh`, { method: 'POST', body: JSON.stringify({ cwd: root }) })).json()) as ProjectDashboard
  expect(p.state.feedReads).toBe(2)
  const host = new URL(p.base).host
  expect(refreshed.sources.find((s) => s.id === 'api')?.error).toBe(`${host} answered HTTP 503`)
  expect(refreshed.sections.find((s) => s.id === 'todo')?.feed).toMatchObject({ total: 1 })

  await first.stop()
  const second = await desk(home, [root])
  const after = await get(second)
  expect(after.sections.find((s) => s.id === 'todo')?.feed).toMatchObject({ items: [{ title: 'Approve the ad budget' }] })
  expect(after.sources.find((s) => s.id === 'api')).toMatchObject({ generatedAt: '2026-10-17T09:00:00Z', error: `${host} answered HTTP 503` })
})

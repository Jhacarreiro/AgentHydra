// plugins/70-orchestrator.ts reads each idle chat's transcript again only when the chat changed: its itemsStamp (GET
// /api/chats?stamps=1) or its updatedAt moved, or it has no stamp. Stand-in engine routes count every transcript fetch;
// each look is the page's GET, which reads once and sends nothing.

import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import type { OrchestratorPlan } from '@shared/orchestrator'
import type { ServerContext } from '../../src/context'
import plugin from '../../src/plugins/70-orchestrator'

const NOW = Date.now()
const MIN = 60_000
const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

function chat(id: string, stamp?: string): ChatSummary {
  return {
    id, sessionId: null, title: id, cwd: 'C:/Users/me/work/repo', account: { id: 'default', label: '#1', configDir: null }, accountAuto: false,
    model: null, effort: null, permissionMode: 'default', delegateToCliMayte: false, status: 'idle', activity: null, turnStartedAt: null,
    lastError: null, limitResetsAt: null, unread: false, pinned: false, archived: false, group: null, forkedFrom: null, createdAt: NOW - 3_600_000,
    updatedAt: NOW - 30 * MIN, costUsd: 0, contextPct: null, pendingCount: 0, queuedCount: 0, climayteActive: 0,
    ...(stamp === undefined ? {} : { itemsStamp: stamp })
  }
}
const done = (id: string): TranscriptItem[] => [
  { id: `u-${id}`, ts: NOW - 40 * MIN, kind: 'user', text: 'tidy the readme' },
  { id: `a-${id}`, ts: NOW - 30 * MIN, kind: 'assistant_text', text: 'Done: the readme is tidied.' }
]

/** The plugin over stand-in routes: `chats` is what GET /api/chats lists (edit it between looks), `fetches` counts
 *  each chat's transcript fetches, and a chat named in `failing` answers 500 once. */
function desk(chats: ChatSummary[]) {
  const app = new Hono()
  const fetches = new Map<string, number>()
  const failing = new Set<string>()
  app.get('/api/chats', (c) => c.json(chats))
  app.get('/api/chats/:id/items', (c) => {
    const id = c.req.param('id')
    fetches.set(id, (fetches.get(id) ?? 0) + 1)
    if (failing.delete(id)) return c.json({ error: 'no transcript' }, 500)
    return c.json(done(id))
  })
  app.get('/api/external/sessions', (c) => c.json([]))
  const settings = { orchestrator: false, orchestratorModel: 'opus' }
  plugin(app, {
    onStop: (fn: () => void) => stops.push(fn),
    settings: () => settings,
    updateSettings: (p: object) => Object.assign(settings, p),
    deps: { orchestratorAsk: async () => ({ text: '{}', resolved: null }) }
  } as unknown as ServerContext)
  const look = async (): Promise<OrchestratorPlan> => (await (await app.request('/api/diagnostics/orchestrator')).json()) as OrchestratorPlan
  const total = (): number => [...fetches.values()].reduce((a, b) => a + b, 0)
  return { look, fetches, failing, total }
}

test('two looks over unchanged chats fetch each transcript once, and the second look classifies them the same', async () => {
  const { look, total } = desk([chat('one', 's1'), chat('two', 's1'), chat('three', 's1')])
  const first = await look()
  const second = await look()
  expect(total()).toBe(3)
  expect(second.rows.map((r) => [r.id, r.move])).toEqual(first.rows.map((r) => [r.id, r.move]))
  expect(second.rows.map((r) => r.move)).toEqual(['done', 'done', 'done'])
})

test("a chat whose itemsStamp moved is fetched again, and only that one", async () => {
  const chats = [chat('same', 's1'), chat('grew', 's1')]
  const { look, fetches } = desk(chats)
  await look()
  chats[1] = { ...chats[1]!, itemsStamp: 's2' }
  await look()
  expect(Object.fromEntries(fetches)).toEqual({ same: 1, grew: 2 })
})

test('a chat whose updatedAt moved is fetched again though its stamp did not', async () => {
  const chats = [chat('same', 's1'), chat('touched', 's1')]
  const { look, fetches } = desk(chats)
  await look()
  chats[1] = { ...chats[1]!, updatedAt: NOW - 5 * MIN }
  await look()
  expect(Object.fromEntries(fetches)).toEqual({ same: 1, touched: 2 })
})

test('a failed fetch is never kept: the next look fetches again, and the one after reuses the good one', async () => {
  const { look, fetches, failing } = desk([chat('flaky', 's1')])
  failing.add('flaky')
  await look()
  await look()
  expect(fetches.get('flaky')).toBe(2)
  await look()
  expect(fetches.get('flaky')).toBe(2)
})

test('a chat that left the list and came back is fetched again', async () => {
  const chats = [chat('stays', 's1'), chat('returns', 's1')]
  const { look, fetches } = desk(chats)
  await look()
  const gone = chats.splice(1, 1)
  await look()
  chats.push(...gone)
  await look()
  expect(Object.fromEntries(fetches)).toEqual({ stays: 1, returns: 2 })
})

test('a chat listed with no itemsStamp is fetched on every look', async () => {
  const { look, fetches } = desk([chat('unstamped'), chat('stamped', 's1')])
  await look()
  await look()
  expect(Object.fromEntries(fetches)).toEqual({ unstamped: 2, stamped: 1 })
})

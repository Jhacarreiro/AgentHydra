// server/tests/manager-routes-refeed.test.ts - Hydra Core's lead pick feeds manager RSI's routes.jsonl again:
// one row per message in the shape managers/router.mjs wrote, none without a lead, a failed write dropped.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { placeChat } from '../src/hydra-core/placement'
import { logRoute } from '../src/manager-analytics/route-log'
import { analyticsPath, ROUTES_FILE } from '../src/manager-analytics/store'
import { scratch } from './hydra-core-fixture'

let core = ''
let managers = ''

const rows = () =>
  readFileSync(analyticsPath(ROUTES_FILE), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

beforeEach(() => {
  core = scratch()
  managers = mkdtempSync(join(tmpdir(), 'managers-'))
  process.env.AGENTHYDRA_MANAGERS_DIR = managers
})

afterEach(() => {
  delete process.env.AGENTHYDRA_MANAGERS_DIR
  rmSync(core, { recursive: true, force: true })
  rmSync(managers, { recursive: true, force: true })
})

const base = {
  session: 'sess-1',
  deskChat: 'chat-1',
  source: 'model',
  message: 1,
  cwd: 'C:/Users/me/proj',
  promptChars: 42,
}

test('a lead writes a row in the router.mjs shape', () => {
  const at = new Date('2019-10-24T10:00:00Z')
  expect(logRoute({ ...base, lead: 'person:iris-ui' }, at)).toBe(true)
  expect(rows()).toEqual([
    {
      v: 1,
      at: '2019-10-24T10:00:00.000Z',
      session: 'sess-1',
      manager: 'iris-ui',
      decision: 'stay',
      why: 'Hydra Core lead',
      source: 'model',
      p: null,
      message: 1,
      pinned: false,
      deskChat: 'chat-1',
      cwd: 'C:/Users/me/proj',
      transcriptPath: null,
      promptChars: 42,
    },
  ])
})

test('a changed lead is a swap', () => {
  logRoute({ ...base, lead: 'person:iris-ui', prev: 'person:ops-lead' })
  expect(rows()[0]?.decision).toBe('swap')
})

test('no lead writes nothing', () => {
  expect(logRoute({ ...base, lead: null })).toBe(false)
  expect(logRoute({ ...base, lead: undefined })).toBe(false)
  expect(() => readFileSync(analyticsPath(ROUTES_FILE))).toThrow()
})

test('a failed write is dropped, not thrown', () => {
  const file = join(managers, 'blocker')
  writeFileSync(file, 'x')
  process.env.AGENTHYDRA_MANAGERS_DIR = file
  expect(logRoute({ ...base, lead: 'person:iris-ui' })).toBe(false)
})

test('placing a chat writes one row per message, and none when the chat has no lead', () => {
  const req = (prompt: string, session: string) => ({
    chat: 'chat-1',
    session,
    fresh: true,
    cwd: 'C:/Users/me/proj',
    prompt,
    placement: 'slot' as const,
    pick: { id: 'person:iris-ui', path: 'model' as const, ms: 1 },
  })
  // A new chat that asks gets no lead at launch (it picks through core_scope), so it writes no row.
  placeChat(core, { ...req('sketch the dashboard layout', 'sess-0'), chat: 'chat-0' })
  expect(() => readFileSync(analyticsPath(ROUTES_FILE))).toThrow()
  writeFileSync(join(core, 'ASK'), 'off')
  placeChat(core, req('sketch the dashboard layout', 'sess-1'))
  placeChat(core, req('now restyle the dashboard', 'sess-2'))
  const got = rows()
  expect(got).toHaveLength(2)
  expect(got.map((r) => [r.session, r.manager, r.deskChat, r.source])).toEqual([
    ['sess-1', 'iris-ui', 'chat-1', 'model'],
    ['sess-2', 'iris-ui', 'chat-1', 'model'],
  ])
})

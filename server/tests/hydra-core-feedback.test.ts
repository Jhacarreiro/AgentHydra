import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogEntry } from '../src/hydra-core/catalog'
import {
  type Feedback,
  feedbackPath,
  foldFeedback,
  foldIfDue,
  movers,
  needsPath,
  priorOf,
  readFeedback,
} from '../src/hydra-core/feedback'
import { rankEntries } from '../src/hydra-core/find'
import { appendLog, readLog } from '../src/hydra-core/log'
import { matchFor, packFor } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { readSent, writeSent } from '../src/hydra-core/sent'
import { findTool } from '../src/hydra-core/tree'
import { CORE_TOOLS } from '../src/mcp-core'
import { scratch } from './hydra-core-fixture'

let dir = ''
const now = new Date('2026-10-14T12:00:00.000Z')
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function plant(events: [number, Record<string, unknown>][]): void {
  for (const [daysAgo, e] of events) appendLog(dir, e, at(daysAgo))
}

function plantFeedback(entries: Feedback['entries'], base = 0.2): void {
  writeFileSync(
    feedbackPath(dir),
    JSON.stringify({ at: now.toISOString(), since: at(90).toISOString(), base, entries }),
  )
}

const k = (name: string, when: string, extra: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({
    id: `knowledge:${name}`,
    kind: 'knowledge',
    name,
    when,
    tags: [],
    cost: 'free',
    how: '',
    load: { type: 'none' },
    ...extra,
  }) as CatalogEntry

test('B4b-1: the fold counts offered, taken, rejected and reported per entry from the last 90 days', () => {
  plant([
    [120, { event: 'pack', chat: 'c0', ids: ['knowledge:brand-notes'] }],
    [5, { event: 'pack', chat: 'c1', ids: ['knowledge:brand-notes', 'person:iris-ui'] }],
    [5, { event: 'placement', phase: 'launch', chat: 'c2', ids: ['knowledge:brand-notes'] }],
    [5, { event: 'find', chat: 'c1', need: 'brand', ids: ['instrument:screen-capture'] }],
    [4, { chat: 'c1', run: 1, step: 'start' }],
    [
      4,
      {
        chat: 'c1',
        run: 1,
        step: 'q2',
        answer: 'x',
        shown: ['person:iris-ui', 'knowledge:brand-notes'],
      },
    ],
    [
      4,
      {
        chat: 'c1',
        run: 1,
        step: 'q3pick',
        answer: '1',
        shown: ['person:iris-ui', 'knowledge:brand-notes'],
      },
    ],
    [4, { chat: 'c1', event: 'use', mode: 'become', id: 'person:ops-lead' }],
    [4, { chat: 'c1', event: 'miss', id: 'instrument:screen-capture', need: 'brand', why: 'more' }],
    [
      4,
      {
        chat: 'c1',
        event: 'miss',
        id: 'knowledge:brand-notes',
        need: 'logo',
        why: 'none',
        better: 'a logo kit',
      },
    ],
    [
      3,
      {
        chat: 'c1',
        run: 1,
        event: 'report',
        outcome: 'done',
        score: 5,
        overruled: ['person:ops-lead'],
      },
    ],
  ])
  const fb = foldFeedback(dir, now)
  expect(fb.entries['knowledge:brand-notes']).toEqual({
    offered: 3,
    taken: 0,
    rejected: 1,
    reported: 0,
  })
  expect(fb.entries['person:iris-ui']).toEqual({ offered: 2, taken: 1, rejected: 0, reported: 2 })
  expect(fb.entries['person:ops-lead']).toEqual({ offered: 0, taken: 1, rejected: 0, reported: 1 })
  expect(fb.entries['instrument:screen-capture']).toEqual({
    offered: 1,
    taken: 0,
    rejected: 1,
    reported: 0,
  })
  expect(fb.base).toBeCloseTo(2 / 6, 5)
  expect(JSON.parse(readFileSync(feedbackPath(dir), 'utf8'))).toEqual(fb)
})

test('B4b-2: the prior raises a taken entry and lowers a rejected one, only past 10 offers', () => {
  const entries = [
    k('alpha', 'release checklist notes'),
    k('beta', 'release checklist notes'),
    k('gamma', 'release checklist notes'),
  ]
  const fb: Feedback = {
    at: now.toISOString(),
    since: at(90).toISOString(),
    base: 0.2,
    entries: {
      'knowledge:alpha': { offered: 20, taken: 0, rejected: 6, reported: 0 },
      'knowledge:gamma': { offered: 20, taken: 10, rejected: 0, reported: 0 },
    },
  }
  const plain = rankEntries(entries, 'release checklist')
  const ranked = rankEntries(entries, 'release checklist', { feedback: fb })
  expect(plain.map((s) => s.entry.id)).toEqual([
    'knowledge:alpha',
    'knowledge:beta',
    'knowledge:gamma',
  ])
  expect(ranked.map((s) => s.entry.id)).toEqual([
    'knowledge:gamma',
    'knowledge:beta',
    'knowledge:alpha',
  ])
  const base = plain[0].score
  expect(ranked[0].score).toBeCloseTo(base * (1 + 0.5 * (11 / 22 - 0.2)), 5)
  expect(ranked[2].score).toBeCloseTo(base * (1 + 0.5 * (1 / 22 - 0.2)), 5)
  // Under 10 offers an entry keeps a fair start, however it fared.
  const young: Feedback = {
    ...fb,
    entries: { 'knowledge:alpha': { offered: 9, taken: 0, rejected: 9, reported: 0 } },
  }
  expect(priorOf(young, 'knowledge:alpha')).toBe(1)
  expect(priorOf(null, 'knowledge:alpha')).toBe(1)
  // Bounded: a perfect record moves the score by at most half.
  const best: Feedback = {
    ...fb,
    base: 0,
    entries: { 'knowledge:alpha': { offered: 400, taken: 400, rejected: 0, reported: 0 } },
  }
  expect(priorOf(best, 'knowledge:alpha')).toBe(1.25)
})

test('B4b-3: packs and per-message additions drop knowledge offered 50+ times and never taken', () => {
  const notes = join(dir, 'brand-notes.md')
  writeFileSync(notes, 'Brand notes: colours and type for the dashboard.\n')
  plantFeedback({ 'knowledge:brand-notes': { offered: 60, taken: 0, rejected: 0, reported: 0 } })
  const prompt = 'which brand colours and type rules apply to the dashboard'
  const pack = packFor(
    dir,
    { chat: 'p1', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(pack.ids).not.toContain('knowledge:brand-notes')
  fs.mkdirSync(chatPaths(dir, 'p2').root, { recursive: true })
  writeSent(chatPaths(dir, 'p2').sent, { s1: [] }, 's1', now)
  const m = matchFor(
    dir,
    { chat: 'p2', session: 's1', cwd: 'C:/Users/me/app', prompt, placement: 'file' },
    now,
  )
  expect(m.ids).not.toContain('knowledge:brand-notes')
  // Taken once, it stays.
  plantFeedback({ 'knowledge:brand-notes': { offered: 60, taken: 1, rejected: 0, reported: 0 } })
  const kept = packFor(
    dir,
    { chat: 'p3', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(kept.ids).toContain('knowledge:brand-notes')
})

test('B4b-3: an entry rejected more often than taken needs a score above MATCH_MIN', () => {
  writeFileSync(
    join(dir, 'catalog', 'hand-extra.json'),
    JSON.stringify([k('zeta-notes', 'quarterly ledger', { how: 'open it' })]),
  )
  // "quarterly" and "ledger" each hit the when (2): a score of exactly MATCH_MIN (4).
  const prompt = 'quarterly ledger'
  const fresh = packFor(
    dir,
    { chat: 'r1', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(fresh.ids).toContain('knowledge:zeta-notes')
  plantFeedback({ 'knowledge:zeta-notes': { offered: 5, taken: 1, rejected: 3, reported: 0 } })
  const raised = packFor(
    dir,
    { chat: 'r2', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null, dry: true },
    now,
  )
  expect(raised.ids).not.toContain('knowledge:zeta-notes')
})

test('B4b-4: feedback-needs.md lists none `better` texts and report `missing` texts, deduped, newest first', () => {
  plant([
    [
      9,
      {
        chat: 'c1',
        event: 'miss',
        id: 'knowledge:a',
        need: 'logo',
        why: 'none',
        better: 'a logo kit',
      },
    ],
    [
      9,
      {
        chat: 'c1',
        event: 'miss',
        id: 'knowledge:b',
        need: 'logo',
        why: 'none',
        better: 'a logo kit',
      },
    ],
    [6, { chat: 'c2', run: 1, event: 'report', outcome: 'partial', missing: 'the refund policy' }],
    [
      2,
      {
        chat: 'c3',
        event: 'miss',
        id: 'knowledge:a',
        need: 'logo',
        why: 'none',
        better: 'A logo kit',
      },
    ],
    [1, { chat: 'c3', event: 'miss', id: 'knowledge:a', need: 'x', why: 'more' }],
  ])
  foldFeedback(dir, now)
  const lines = readFileSync(needsPath(dir), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- '))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('A logo kit')
  expect(lines[0]).toContain(at(2).toISOString().slice(0, 10))
  expect(lines[1]).toContain('the refund policy')
})

test('B4b-5: core_stats shows the prior top movers, up and down', async () => {
  plantFeedback(
    {
      'knowledge:up': { offered: 30, taken: 20, rejected: 0, reported: 0 },
      'knowledge:down': { offered: 30, taken: 0, rejected: 9, reported: 0 },
      'knowledge:young': { offered: 3, taken: 3, rejected: 0, reported: 0 },
    },
    0.2,
  )
  const m = movers(readFeedback(dir))
  expect(m.up.map((x) => x.id)).toEqual(['knowledge:up'])
  expect(m.down.map((x) => x.id)).toEqual(['knowledge:down'])
  expect(m.up[0].prior).toBeGreaterThan(1)
  const stats = CORE_TOOLS.find((t) => t.name === 'core_stats')
  const out = (await stats?.run({})) as {
    learned?: { up: { id: string }[]; down: { id: string }[] }
  }
  expect(out.learned?.up[0]?.id).toBe('knowledge:up')
  expect(out.learned?.down[0]?.id).toBe('knowledge:down')
})

test('B4b-1: the fold never runs inside a pack, match or find request; a timer folds a stale file', () => {
  plant([[3, { event: 'pack', chat: 'c1', ids: ['knowledge:brand-notes'] }]])
  const prompt = 'brand colours for the dashboard'
  packFor(dir, { chat: 'q1', session: 's1', cwd: 'C:/Users/me/app', prompt, lead: null }, now)
  matchFor(
    dir,
    { chat: 'q2', session: 's1', cwd: 'C:/Users/me/app', prompt, placement: 'file' },
    now,
  )
  findTool(dir, { chat: 'q1', need: 'brand colours' }, now)
  expect(existsSync(feedbackPath(dir))).toBe(false)
  expect(foldIfDue(dir, now)).toBe(true)
  expect(existsSync(feedbackPath(dir))).toBe(true)
  expect(foldIfDue(dir, now)).toBe(false)
  const old = new Date(now.getTime() - 25 * 60 * 60 * 1000)
  utimesSync(feedbackPath(dir), old, old)
  expect(foldIfDue(dir, now)).toBe(true)
})

test('B4b-1: rank code reads feedback.json once per change (cached by mtime)', () => {
  plantFeedback({ 'knowledge:x': { offered: 20, taken: 10, rejected: 0, reported: 0 } })
  const spy = spyOn(fs, 'readFileSync')
  readFeedback(dir)
  readFeedback(dir)
  const reads = spy.mock.calls.filter((c) => String(c[0]).endsWith('feedback.json')).length
  spy.mockRestore()
  expect(reads).toBeLessThanOrEqual(1)
})

test('B4b-6: a rotation whose rename fails (log.jsonl held on Windows) never throws out of appendLog', () => {
  appendLog(dir, { event: 'first' }, new Date('2026-09-30T00:00:00Z'))
  const spy = spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
  })
  try {
    expect(() =>
      appendLog(dir, { event: 'second' }, new Date('2026-10-02T00:00:00Z')),
    ).not.toThrow()
  } finally {
    spy.mockRestore()
  }
  expect(readLog(dir).events.map((e) => e.event)).toEqual(['first', 'second'])
  appendLog(dir, { event: 'third' }, new Date('2026-10-02T00:01:00Z'))
  expect(existsSync(join(dir, 'log-2026-09.jsonl'))).toBe(true)
  expect(readLog(dir).events.map((e) => e.event)).toEqual(['first', 'second', 'third'])
})

test('B4b-6: sent.json keeps a session seen in the last week even when its list did not change', () => {
  const file = chatPaths(dir, 'seen').sent
  const t0 = new Date('2026-10-01T00:00:00Z')
  writeSent(file, { a: ['knowledge:brand-notes'] }, 'a', t0)
  writeSent(file, readSent(file), 'a', new Date(t0.getTime() + 6 * DAY))
  writeSent(
    file,
    { ...readSent(file), b: ['person:iris-ui'] },
    'b',
    new Date(t0.getTime() + 9 * DAY),
  )
  expect(Object.keys(readSent(file)).sort()).toEqual(['a', 'b'])
  writeSent(file, readSent(file), 'b', new Date(t0.getTime() + 14 * DAY))
  expect(Object.keys(readSent(file))).toEqual(['b'])
})

test('B4b-6: a per-message match with nothing new still marks its session seen', () => {
  const file = chatPaths(dir, 'm1').sent
  const t0 = new Date('2026-10-01T00:00:00Z')
  writeSent(file, { s1: ['knowledge:brand-notes'], other: [] }, 's1', t0)
  matchFor(
    dir,
    { chat: 'm1', session: 's1', cwd: 'C:/Users/me/app', prompt: 'ok', placement: 'file' },
    new Date(t0.getTime() + 6 * DAY),
  )
  writeSent(file, readSent(file), 'other', new Date(t0.getTime() + 9 * DAY))
  expect(readSent(file).s1).toEqual(['knowledge:brand-notes'])
})

// Run in a fresh process: earlier test files in the same run repoint AGENTHYDRA_HOME and AGENTHYDRA_CORE_DIR.
test('B4b-8: the test preload points AGENTHYDRA_CORE_DIR at its scratch folder, never the live core', () => {
  const env = { ...process.env }
  delete env.AGENTHYDRA_HOME
  delete env.AGENTHYDRA_CORE_DIR
  const body =
    'console.log(JSON.stringify([process.env.AGENTHYDRA_HOME ?? "", process.env.AGENTHYDRA_CORE_DIR ?? ""]))'
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '--preload',
      join(import.meta.dir, '..', '..', 'tests', 'setup.ts'),
      '-e',
      body,
    ],
    { env },
  )
  const [home, preset] = JSON.parse(
    proc.stdout.toString().trim().split('\n').pop() ?? '[]',
  ) as string[]
  expect(home).not.toBe('')
  expect(preset).toBe(join(home, 'core'))
  expect(preset).not.toContain(join('.agenthydra', 'core'))
})

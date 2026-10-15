import './lessons-home.mjs'
import { afterEach, beforeEach, describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adviceFile, appendRow, readRows } from '../../lib/advice/log.mjs'
import { reconcile, summarize } from '../../lib/advice/reconcile.mjs'
import { historyFile } from '../../lib/history.mjs'

const ROOT = path.resolve('C:/Users/me/Projects/example-shop')
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetDays) => new Date(T0 + offsetDays * DAY).toISOString()

let home
let previous

beforeEach(() => {
  previous = process.env.PRICECHECK_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pricecheck-reconcile-'))
  process.env.PRICECHECK_HOME = home
})

afterEach(() => {
  if (previous === undefined) delete process.env.PRICECHECK_HOME
  else process.env.PRICECHECK_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
})

function snap(day, version, pages, root = ROOT) {
  const row = {
    at: iso(day),
    root,
    repo: path.basename(root),
    mode: 'static',
    total: pages.reduce((n, p) => n + p.points, 0),
    pages: pages.map((p) => ({ page: p.page, points: p.points, units: {} })),
    version,
    head: null,
  }
  appendRow(historyFile(), row)
  return row
}

function advice(id, day, page, points, version, root = ROOT) {
  appendRow(adviceFile(), {
    type: 'advice',
    id,
    at: iso(day),
    kind: 'next',
    root,
    repo: path.basename(root),
    page,
    points,
    claim: `trim ${page}`,
    version,
    head: null,
  })
}

const kinds = (rows) => rows.map((r) => r.kind)

group('outcomes', () => {
  test('followed: the page is cheaper than when it was advised, in a later snapshot of the same version', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }])
    const { added } = reconcile(ROOT, { now: T0 + 3 * DAY })
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ type: 'outcome', adviceId: 'a1', kind: 'followed', points: 30, snapshotAt: iso(2) })
  })

  test('undone: the page is dearer than when it was advised, same version', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 50 }])
    const { added } = reconcile(ROOT, { now: T0 + 3 * DAY })
    expect(added.map((o) => o.kind)).toEqual(['undone'])
  })

  test('misled: the advice was made under the same version the page then changed under a new version, so pricecheck moved the number', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v2', [{ page: 'src/views/Landing.vue', points: 52 }])
    const { added } = reconcile(ROOT, { now: T0 + 3 * DAY })
    expect(added.map((o) => o.kind)).toEqual(['misled'])
  })

  test('a version change that makes the page cheaper is followed, not misled', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v2', [{ page: 'src/views/Landing.vue', points: 30 }])
    const { added } = reconcile(ROOT, { now: T0 + 3 * DAY })
    expect(added.map((o) => o.kind)).toEqual(['followed'])
  })

  test('no outcome while no later snapshot covers the page', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v1', [{ page: 'src/views/Other.vue', points: 10 }])
    expect(reconcile(ROOT, { now: T0 + 3 * DAY }).added).toEqual([])
  })

  test('no outcome for a snapshot taken before the advice', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    expect(reconcile(ROOT, { now: T0 + 3 * DAY }).added).toEqual([])
  })

  test('uses the latest snapshot after the advice, so an early dearer scan does not hide a later cheaper one', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 50 }])
    snap(3, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }])
    const { added } = reconcile(ROOT, { now: T0 + 4 * DAY })
    expect(added.map((o) => [o.kind, o.snapshotAt])).toEqual([['followed', iso(3)]])
  })

  test('ignores snapshots and advice from another root', () => {
    const other = path.resolve('C:/Users/me/Projects/other-shop')
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }], other)
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1', other)
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }], other)
    expect(reconcile(ROOT, { now: T0 + 3 * DAY }).added).toEqual([])
    expect(reconcile(other, { now: T0 + 3 * DAY }).added.map((o) => o.kind)).toEqual(['followed'])
  })

  test('advice without a page (a check failure) gets no followed or undone outcome', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    appendRow(adviceFile(), { type: 'advice', id: 'c1', at: iso(1), kind: 'check', root: ROOT, claim: 'stale', version: 'v1' })
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }])
    expect(reconcile(ROOT, { now: T0 + 3 * DAY }).added).toEqual([])
  })
})

group('stale', () => {
  test('an advice with no outcome after 30 days is stale', () => {
    advice('a1', 0, 'src/views/Landing.vue', 40, 'v1')
    const { added } = reconcile(ROOT, { now: T0 + 31 * DAY })
    expect(added.map((o) => [o.adviceId, o.kind])).toEqual([['a1', 'stale']])
  })

  test('an advice younger than 30 days is not stale yet', () => {
    advice('a1', 0, 'src/views/Landing.vue', 40, 'v1')
    expect(reconcile(ROOT, { now: T0 + 29 * DAY }).added).toEqual([])
  })

  test('an advice that already has an outcome is never marked stale', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }])
    const { added } = reconcile(ROOT, { now: T0 + 90 * DAY })
    expect(kinds(added)).toEqual(['followed'])
  })
})

group('idempotence', () => {
  test('a second run adds nothing and leaves the store unchanged', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }])
    const first = reconcile(ROOT, { now: T0 + 3 * DAY })
    const before = fs.readFileSync(adviceFile(), 'utf8')
    const second = reconcile(ROOT, { now: T0 + 3 * DAY })
    expect(second.added).toEqual([])
    expect(second.outcomes).toEqual(first.outcomes)
    expect(fs.readFileSync(adviceFile(), 'utf8')).toBe(before)
  })

  test('a new later snapshot that changes the outcome adds a new outcome row, and the old one stays', () => {
    snap(0, 'v1', [{ page: 'src/views/Landing.vue', points: 40 }])
    advice('a1', 1, 'src/views/Landing.vue', 40, 'v1')
    snap(2, 'v1', [{ page: 'src/views/Landing.vue', points: 30 }])
    reconcile(ROOT, { now: T0 + 3 * DAY })
    snap(4, 'v1', [{ page: 'src/views/Landing.vue', points: 55 }])
    const second = reconcile(ROOT, { now: T0 + 5 * DAY })
    expect(second.added.map((o) => o.kind)).toEqual(['undone'])
    expect(readRows(adviceFile()).filter((r) => r.type === 'outcome').map((r) => r.kind)).toEqual(['followed', 'undone'])
  })

  test('writes nothing when there are no advice rows', () => {
    expect(reconcile(ROOT, { now: T0 })).toEqual({ added: [], outcomes: [] })
    expect(fs.existsSync(adviceFile())).toBe(false)
  })
})

group('summarize', () => {
  test('counts issued advice, each outcome kind, feedback verdicts, and the share of bad advice', () => {
    snap(0, 'v1', [
      { page: 'a.vue', points: 40 },
      { page: 'b.vue', points: 40 },
      { page: 'c.vue', points: 40 },
      { page: 'd.vue', points: 40 },
    ])
    advice('a1', 1, 'a.vue', 40, 'v1')
    advice('a2', 1, 'b.vue', 40, 'v1')
    advice('a3', 1, 'c.vue', 40, 'v1')
    advice('a4', 1, 'd.vue', 40, 'v1')
    snap(2, 'v1', [
      { page: 'a.vue', points: 30 },
      { page: 'b.vue', points: 50 },
      { page: 'c.vue', points: 40 },
      { page: 'd.vue', points: 40 },
    ])
    reconcile(ROOT, { now: T0 + 3 * DAY })
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a3', verdict: 'wrong', claim: 'c.vue is not 40', at: iso(3), by: 'owner' })

    const s = summarize(ROOT, { now: T0 + 3 * DAY })
    expect(s).toMatchObject({ issued: 4, followed: 1, undone: 1, misled: 0, stale: 0, feedback: { wrong: 1, undone: 0, right: 0 } })
    expect(s.badRate).toBe(0.5)
  })

  test('a feedback verdict of undone counts as undone for an advice', () => {
    advice('a1', 0, 'a.vue', 40, 'v1')
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a1', verdict: 'undone', claim: 'reverted', at: iso(1) })
    const s = summarize(ROOT, { now: T0 + 1 * DAY })
    expect(s.undone).toBe(1)
    expect(s.feedback.undone).toBe(1)
    expect(s.badRate).toBe(1)
  })

  test('badRate is null when nothing was issued', () => {
    expect(summarize(ROOT, { now: T0 })).toMatchObject({ issued: 0, badRate: null })
  })

  test('an advice followed and later undone counts once, as undone, and still counts as ever followed', () => {
    advice('a1', 0, 'a.vue', 40, 'v1')
    snap(1, 'v1', [{ page: 'a.vue', points: 30 }])
    reconcile(ROOT, { now: T0 + 2 * DAY })
    snap(2, 'v1', [{ page: 'a.vue', points: 50 }])
    expect(summarize(ROOT, { now: T0 + 3 * DAY })).toMatchObject({ issued: 1, followed: 0, undone: 1, everFollowed: 1, badRate: 1 })
  })

  test('an advice undone and later followed again counts once, as followed, and is not bad', () => {
    advice('a1', 0, 'a.vue', 40, 'v1')
    snap(1, 'v1', [{ page: 'a.vue', points: 50 }])
    reconcile(ROOT, { now: T0 + 2 * DAY })
    snap(2, 'v1', [{ page: 'a.vue', points: 30 }])
    expect(summarize(ROOT, { now: T0 + 3 * DAY })).toMatchObject({ issued: 1, followed: 1, undone: 0, everFollowed: 1, badRate: 0 })
  })

  test('the latest feedback decides: wrong then right is not bad, right then wrong is', () => {
    advice('a1', 0, 'a.vue', 40, 'v1')
    advice('a2', 0, 'b.vue', 40, 'v1')
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a1', verdict: 'wrong', claim: 'x', at: iso(1) })
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a1', verdict: 'right', claim: 'x', at: iso(2) })
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a2', verdict: 'right', claim: 'y', at: iso(1) })
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a2', verdict: 'wrong', claim: 'y', at: iso(2) })
    const s = summarize(ROOT, { now: T0 + 3 * DAY })
    expect(s.feedback).toEqual({ wrong: 2, undone: 0, right: 2 })
    expect(s.badRate).toBe(0.5)
  })

  test('a feedback row with no advice id counts in the badRate numerator when it is wrong or undone', () => {
    advice('a1', 0, 'a.vue', 40, 'v1')
    advice('a2', 0, 'b.vue', 40, 'v1')
    appendRow(adviceFile(), { type: 'feedback', verdict: 'wrong', claim: 'the check is off', root: ROOT, at: iso(1) })
    appendRow(adviceFile(), { type: 'feedback', verdict: 'right', claim: 'fine', root: ROOT, at: iso(1) })
    const s = summarize(ROOT, { now: T0 + 2 * DAY })
    expect(s.feedback).toEqual({ wrong: 1, undone: 0, right: 1 })
    expect(s.badRate).toBe(0.5)
  })

  test('a six-snapshot history over two versions, with all four outcomes, sums to the exact summary', () => {
    snap(1, 'v1', [{ page: 'a.vue', points: 40 }, { page: 'b.vue', points: 40 }, { page: 'c.vue', points: 40 }])
    snap(2, 'v1', [{ page: 'a.vue', points: 30 }, { page: 'b.vue', points: 40 }, { page: 'c.vue', points: 40 }])
    snap(3, 'v1', [{ page: 'a.vue', points: 30 }, { page: 'b.vue', points: 40 }, { page: 'c.vue', points: 40 }])
    snap(4, 'v2', [{ page: 'a.vue', points: 30 }, { page: 'b.vue', points: 50 }, { page: 'c.vue', points: 40 }])
    snap(5, 'v2', [{ page: 'a.vue', points: 30 }, { page: 'b.vue', points: 50 }, { page: 'c.vue', points: 50 }])
    snap(6, 'v2', [{ page: 'a.vue', points: 30 }, { page: 'b.vue', points: 50 }, { page: 'c.vue', points: 50 }])
    advice('a1', 0, 'a.vue', 40, 'v1')
    advice('a2', 0, 'b.vue', 40, 'v1')
    advice('a3', 4.5, 'c.vue', 40, 'v2')
    advice('a4', 0, 'd.vue', 40, 'v1')
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a1', verdict: 'wrong', claim: 'a is not cheaper', at: iso(2) })
    appendRow(adviceFile(), { type: 'feedback', adviceId: 'a1', verdict: 'right', claim: 'a is cheaper', at: iso(3) })
    appendRow(adviceFile(), { type: 'feedback', verdict: 'wrong', claim: 'the check is off', root: ROOT, at: iso(5) })
    expect(summarize(ROOT, { now: T0 + 40 * DAY })).toEqual({
      root: ROOT,
      issued: 4,
      followed: 1,
      everFollowed: 1,
      undone: 1,
      misled: 1,
      stale: 1,
      feedback: { wrong: 2, undone: 0, right: 1 },
      badRate: 0.75,
    })
  })
})

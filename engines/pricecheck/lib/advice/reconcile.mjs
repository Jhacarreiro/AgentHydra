import path from 'node:path'
import { adviceFile, appendRow, readRows } from './log.mjs'
import { readHistory } from '../history.mjs'
import { lessonFromOutcome } from './lessons.mjs'

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

const ms = (iso) => Date.parse(iso)

function rowsFor(root) {
  const want = path.resolve(root)
  const rows = readRows(adviceFile())
  const advice = rows.filter((r) => r.type === 'advice' && r.root && path.resolve(r.root) === want)
  const ids = new Set(advice.map((a) => a.id))
  const feedback = rows.filter((r) => r.type === 'feedback' && (ids.has(r.adviceId) || (r.root && path.resolve(r.root) === want)))
  const outcomes = rows.filter((r) => r.type === 'outcome' && ids.has(r.adviceId))
  return { advice, feedback, outcomes }
}

function outcomeFor(advice, snaps) {
  if (!advice.page) return null
  const after = snaps.filter((s) => ms(s.at) > ms(advice.at))
  for (let i = after.length - 1; i >= 0; i--) {
    const row = after[i].pages.find((p) => p.page === advice.page)
    if (!row) continue
    if (row.points < advice.points) return { kind: 'followed', snap: after[i], points: row.points }
    if (row.points > advice.points) {
      const kind = after[i].version !== advice.version ? 'misled' : 'undone'
      return { kind, snap: after[i], points: row.points }
    }
    return null
  }
  return null
}

export function reconcile(root, { now = Date.now() } = {}) {
  const resolved = path.resolve(root)
  const snaps = readHistory(resolved).slice().sort((a, b) => ms(a.at) - ms(b.at))
  const { advice, outcomes } = rowsFor(resolved)
  const written = new Set(outcomes.map((o) => `${o.adviceId}|${o.kind}|${o.snapshotAt ?? ''}`))
  const added = []
  const write = (row, a) => {
    appendRow(adviceFile(), row)
    lessonFromOutcome(row, a)
    written.add(`${row.adviceId}|${row.kind}|${row.snapshotAt ?? ''}`)
    added.push(row)
  }

  for (const a of advice) {
    const found = outcomeFor(a, snaps)
    if (found) {
      const key = `${a.id}|${found.kind}|${found.snap.at}`
      if (!written.has(key)) {
        write({ type: 'outcome', adviceId: a.id, kind: found.kind, at: new Date(now).toISOString(), snapshotAt: found.snap.at, points: found.points, version: found.snap.version }, a)
      }
      continue
    }
    const hasAny = outcomes.some((o) => o.adviceId === a.id)
    if (!hasAny && now - ms(a.at) >= STALE_AFTER_MS && !written.has(`${a.id}|stale|`)) {
      write({ type: 'outcome', adviceId: a.id, kind: 'stale', at: new Date(now).toISOString(), snapshotAt: null, points: null, version: null }, a)
    }
  }

  const all = readRows(adviceFile()).filter((r) => r.type === 'outcome' && advice.some((a) => a.id === r.adviceId))
  return { added, outcomes: all }
}

export function summarize(root, { now = Date.now() } = {}) {
  reconcile(root, { now })
  const { advice, feedback, outcomes } = rowsFor(root)
  const ids = new Set(advice.map((a) => a.id))
  const latestBy = (rows) => {
    const last = new Map()
    for (const r of [...rows].sort((a, b) => ms(a.at) - ms(b.at))) last.set(r.adviceId, r)
    return last
  }
  const lastOutcome = latestBy(outcomes)
  const lastFeedback = latestBy(feedback.filter((f) => ids.has(f.adviceId)))
  const stateOf = (id) => lastOutcome.get(id)?.kind ?? (lastFeedback.get(id)?.verdict === 'undone' ? 'undone' : null)
  const everFollowed = [...ids].filter((id) => outcomes.some((o) => o.adviceId === id && o.kind === 'followed')).length
  const bad = (id) => ['undone', 'misled'].includes(stateOf(id)) || ['wrong', 'undone'].includes(lastFeedback.get(id)?.verdict)
  const looseBad = feedback.filter((f) => !f.adviceId && (f.verdict === 'wrong' || f.verdict === 'undone')).length
  const count = (state) => [...ids].filter((id) => stateOf(id) === state).length
  const issued = ids.size
  const tally = (verdict) => feedback.filter((f) => f.verdict === verdict).length
  return {
    root: path.resolve(root),
    issued,
    followed: count('followed'),
    everFollowed,
    undone: count('undone'),
    misled: count('misled'),
    stale: count('stale'),
    feedback: { wrong: tally('wrong'), undone: tally('undone'), right: tally('right') },
    badRate: issued === 0 ? null : ([...ids].filter(bad).length + looseBad) / issued,
  }
}

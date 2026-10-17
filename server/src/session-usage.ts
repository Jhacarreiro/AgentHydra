// server/src/session-usage.ts — tokens and dollars for ONE session, read from the analytics kit.
//
// The kit's per-session ledger (docs/ANALYTICS-PLAN.md §4) already holds every Claude call of a
// session, its subagents' calls included, priced at the rate in force when each call ran. This file
// only reshapes a `usageQuery` answer into the two response shapes the Sessions chip and the run-cost
// endpoint have always returned. A session the kit has not swept yet (brand new, before the next
// ingest pass) has no rows and answers a real zero, the same as an empty transcript always did.

import type { CliMayteWorker } from './climayte-lib'
import { dispatchedFrom } from './climayte-view'
import { type UsageQueryOpts, usageQuery } from './kit/query'
import { pricesAsOf } from './pricing'
import type { TranscriptFile } from './transcript'
import type { RunCost, SessionUsage } from './types'

/** Kit sources that are Claude calls. HSwarm workers a session spawned are billed elsewhere and, on a
 *  busy session, number in the tens of thousands: this chip and a run's cost are Claude spend. */
const CLAUDE_SOURCES = ['cli', 'desktop', 'climayte']

type Tokens = SessionUsage['tokens']

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** Sums of one session's (optionally windowed) kit rows, split by model so priced and unpriced
 *  models can be named. */
function spend(
  session: string,
  window: { from: number; to?: number } | { last: 'all' },
  opts: UsageQueryOpts,
): { tokens: Tokens; costUsd: number | null; priced: string[]; unpriced: string[] } {
  const res = usageQuery(
    {
      window,
      filter: { session: [session], source: CLAUDE_SOURCES },
      groupBy: ['model'],
      measures: ['tokens', 'input', 'output', 'cache_read', 'cache_write', 'calls', 'list_usd'],
    },
    { ...opts, coverage: false },
  )
  const priced: string[] = []
  const unpriced = new Set(res.unpriced)
  for (const r of res.rows) {
    const model = r.model
    if (typeof model !== 'string' || model === '') continue
    if (r.list_usd === null && num(r.tokens) > 0) unpriced.add(model)
    else if (r.list_usd !== null) priced.push(model)
  }
  const t = res.totals
  return {
    tokens: {
      input: num(t.input),
      output: num(t.output),
      cacheRead: num(t.cache_read),
      cacheCreation: num(t.cache_write),
      total: num(t.tokens),
      turns: num(t.calls),
    },
    costUsd: t.list_usd ?? null,
    priced: priced.sort(),
    unpriced: [...unpriced].sort(),
  }
}

/** Adds dollar figures, null only when every one is null. */
const addUsd = (...xs: (number | null | undefined)[]): number | null =>
  xs.reduce<number | null>((sum, x) => (x == null ? sum : (sum ?? 0) + x), null)

/** HSwarm's ledger names its caller by the session id's first 8 characters (the key HSwarm's MCP server
 *  is given; ledger.jsonl's `caller_session`, the kit's `session` for its rows), a newer line by the whole
 *  id: both are asked for. Two sessions whose ids share the first 8 characters would share these rows. */
const hswarmCallers = (ids: Iterable<string>): string[] => [
  ...new Set([...ids].flatMap((id) => [id, id.slice(0, 8)])),
]

export interface SessionUsageOpts extends UsageQueryOpts {
  /** Every CliMayte worker on record (climayte-view climayteWorkers); the ones this session started are
   *  found in it. Without it, no CliMayte work is counted. */
  workers?: Iterable<CliMayteWorker>
}

/**
 * What a session's handed-off work spent (SessionUsage.delegated), from the analytics kit:
 *
 *  * CliMayte: every worker the session started, by its ping origin or, with none, its trace (a
 *    CliMayte-routed HSwarm task's worker names the calling chat only there), and every worker those
 *    started in turn (dispatchedFrom with `trace`). Each worker's sessions, earlier ones included, are
 *    Claude calls in the kit like the session's own, so they are counted the same way.
 *  * HSwarm: the ledger's rows for the session and for those workers' sessions (a worker's own HSwarm
 *    calls), except the ones HSwarm routed to CliMayte: that work is a worker's session, counted above,
 *    and HSwarm's line for it records part of it or nothing.
 */
export function delegatedUsage(
  sessionId: string,
  opts: SessionUsageOpts = {},
): SessionUsage['delegated'] {
  const { workers, ...kit } = opts
  const list = workers ? [...workers] : []
  const mine = dispatchedFrom(list, [sessionId], { trace: true })
  const sessions = new Set<string>()
  for (const w of list) {
    if (!mine.has(w.id)) continue
    for (const s of [w.sessionId, ...(w.sessions ?? [])]) if (s && s !== sessionId) sessions.add(s)
  }
  let climayte = { tokens: 0, costUsd: null as number | null }
  if (sessions.size) {
    const res = usageQuery(
      {
        window: { last: 'all' },
        filter: { session: [...sessions], source: CLAUDE_SOURCES },
        measures: ['tokens', 'list_usd'],
      },
      { ...kit, coverage: false },
    )
    climayte = { tokens: num(res.totals.tokens), costUsd: res.totals.list_usd ?? null }
  }
  const hswarm = { tokens: 0, costUsd: null as number | null, calls: 0 }
  const res = usageQuery(
    {
      window: { last: 'all' },
      filter: { session: hswarmCallers([sessionId, ...sessions]), source: 'hswarm' },
      groupBy: ['provider'],
      measures: ['tokens', 'list_usd', 'calls'],
    },
    { ...kit, coverage: false },
  )
  for (const r of res.rows) {
    if (r.provider === 'climayte') continue
    hswarm.tokens += num(r.tokens)
    hswarm.calls += num(r.calls)
    hswarm.costUsd = addUsd(hswarm.costUsd, typeof r.list_usd === 'number' ? r.list_usd : null)
  }
  return { hswarm, climayte: { ...climayte, workers: mine.size } }
}

const NO_DELEGATION: SessionUsage['delegated'] = {
  hswarm: { tokens: 0, costUsd: null, calls: 0 },
  climayte: { tokens: 0, costUsd: null, workers: 0 },
}

/**
 * Tokens and cost for one session, subagents included, and what the HSwarm and CliMayte work it handed
 * off spent (delegatedUsage), with the grand total of the three.
 *
 * Claude only: a Codex rollout and an OpenCode row answer `source-unsupported` so the UI can say
 * why rather than showing a silent zero.
 */
export function sessionUsage(tf: TranscriptFile, opts: SessionUsageOpts = {}): SessionUsage {
  const base = {
    session_id: tf.session_id,
    source: tf.source,
    pricesAsOf: pricesAsOf(),
  }
  if (tf.source !== 'claude') {
    return {
      ...base,
      status: 'source-unsupported',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0 },
      costUsd: null,
      pricedModels: [],
      unpricedModels: [],
      delegated: NO_DELEGATION,
      grand: { tokens: 0, costUsd: null },
    }
  }
  const { workers: _workers, ...kit } = opts
  const s = spend(tf.session_id, { last: 'all' }, kit)
  const d = delegatedUsage(tf.session_id, opts)
  return {
    ...base,
    status: 'ok',
    tokens: s.tokens,
    costUsd: s.costUsd,
    pricedModels: s.priced,
    unpricedModels: s.unpriced,
    delegated: d,
    grand: {
      tokens: s.tokens.total + d.hswarm.tokens + d.climayte.tokens,
      costUsd: addUsd(s.costUsd, d.hswarm.costUsd, d.climayte.costUsd),
    },
  }
}

/**
 * What one queued run cost: the session's calls inside the run's own window (start to finish; an
 * unfinished run is open-ended, since it is still spending). Closed at both ends so turns typed by
 * hand after the run finished are not charged to it. Computed, never stored.
 */
export function runCost(
  item: {
    id: string
    session_id: string
    status: string
    started_at: string | null
    finished_at: string | null
  },
  opts: UsageQueryOpts = {},
): RunCost {
  const base: RunCost = {
    id: item.id,
    session_id: item.session_id,
    status: item.status,
    startedAt: item.started_at,
    finishedAt: item.finished_at,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0 },
    costUsd: null,
    unpricedModels: [],
    pricesAsOf: pricesAsOf(),
    status_reason: 'ok',
  }
  const from = item.started_at ? Date.parse(item.started_at) : Number.NaN
  if (!Number.isFinite(from)) return { ...base, status_reason: 'no-window' }
  const to = item.finished_at ? Date.parse(item.finished_at) : Number.NaN
  const s = spend(item.session_id, Number.isFinite(to) ? { from, to } : { from }, opts)
  return { ...base, tokens: s.tokens, costUsd: s.costUsd, unpricedModels: s.unpriced }
}

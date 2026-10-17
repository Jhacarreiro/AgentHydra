// A routine's campaigns (shared/routines.ts, GROUP AND CAMPAIGNS): each campaign id the routine names is read from the
// CrAInium's Campaigns arm through the person's own Connections server, its `campaigns` tool, the way store-crainium.ts
// calls `docs` and `routine_runs`. The arm's record becomes a CampaignLedger: its words and numbers, never an address (its
// touch rows are not read at all). Each routine's answer is kept CAMPAIGNS_CACHE_MS; `fresh` skips it. Keeps nothing on disk.

import type { CampaignLedger, RoutineCampaigns } from '@shared/routines'
import { jsonAnswer } from '../connectors/connections-client'
import type { ConnectionsCall } from './manager-central'
import { message } from './proc'

/** The Connections tool the Campaigns arm answers through. */
export const CAMPAIGNS_TOOL = 'campaigns'
/** How long a routine's answer is kept, so a page that asks again within a minute does not ask the arm again. */
export const CAMPAIGNS_CACHE_MS = 60_000
/** The most days with sends a ledger keeps, and the most run lines. */
const DAYS_MAX = 14
const RUNS_MAX = 5
/** The most routines whose answer is kept; past it the oldest kept answer goes first. */
const KEPT_MAX = 200

type Run = CampaignLedger['runs'][number]
/** One campaign's answer: its ledger; `unknown` when the arm has no record of it (its error text, when it gave one); `failed`
 *  when the Connections server did not answer in a record at all (no server, a refusal in words, a throw). */
type Lookup = { ledger: CampaignLedger } | { unknown: string | null } | { failed: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
/** An ISO time (or ms), as ms; anything else is null. */
const when = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? ms : null
}
/** The non-empty strings of a list; anything else in it is dropped. */
const lines = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).flatMap((x) => {
    const s = str(x)
    return s ? [s] : []
  })

/** One run line of the arm's, or null when it has no time. */
function runOf(v: unknown): Run | null {
  if (!isRecord(v)) return null
  const at = when(v.at)
  if (at === null) return null
  return {
    at,
    routine: str(v.routine),
    sent: num(v.sent),
    replies: num(v.replies),
    bounces: num(v.bounces),
    queued: num(v.queued),
    note: str(v.note) ?? '',
    problems: lines(v.problems),
  }
}

/** A campaign's `show` answer, as a ledger. The arm answers `{ campaign, metrics, runs, touches }`: the record, its numbers
 *  (sends by day, the last run) and its run lines beside it (read 2026-10-17). `ready` is the newest run's queue, what the
 *  next sends take from. Every field is optional: a wrong type is dropped, not refused. */
function ledgerOf(id: string, r: Record<string, unknown>, answer: Record<string, unknown>): CampaignLedger {
  const metrics = isRecord(answer.metrics) ? answer.metrics : isRecord(r.metrics) ? r.metrics : null
  const days = metrics && isRecord(metrics.days) ? metrics.days : {}
  const listed = Array.isArray(answer.runs) ? answer.runs : Array.isArray(r.runs) ? r.runs : null
  const runs = (listed ?? (metrics && isRecord(metrics.lastRun) ? [metrics.lastRun] : []))
    .flatMap((v) => {
      const run = runOf(v)
      return run ? [run] : []
    })
    .sort((a, b) => b.at - a.at)
  const count = (key: string): number => num(metrics?.[key]) ?? 0
  return {
    id,
    name: str(r.name) ?? id,
    status: str(r.status) ?? 'unknown',
    statusWhy: str(r.statusWhy),
    goal: str(r.goal),
    cadence: str(r.cadence),
    now: lines(r.now),
    next: lines(r.next),
    ready: runs[0]?.queued ?? null,
    numbers: metrics
      ? {
          sent: count('sent'),
          replied: count('replied'),
          bounced: count('bounced'),
          optedOut: count('optedOut'),
          paid: count('paid'),
          followUps: count('followUps'),
          pending: count('pending'),
          lastSentAt: when(metrics.lastSentAt),
        }
      : null,
    days: Object.entries(days)
      .flatMap(([day, n]) => {
        const sent = num(n)
        return /^\d{4}-\d{2}-\d{2}$/.test(day) && sent !== null && sent > 0 ? [{ day, sent }] : []
      })
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-DAYS_MAX),
    runs: runs.slice(0, RUNS_MAX),
  }
}

/** One campaign, asked of the arm: `show` answers its record. */
async function lookup(call: ConnectionsCall, campaign: string): Promise<Lookup> {
  let text: string
  try {
    text = await call(CAMPAIGNS_TOOL, { action: 'show', campaign })
  } catch (err) {
    return { failed: message(err) }
  }
  const json = jsonAnswer(text)
  if (!json) return { failed: 'the Campaigns arm answered in words, not a record' }
  if (json.error !== undefined) return { unknown: str(json.error) ?? 'the Campaigns arm refused it' }
  const record = isRecord(json.campaign) ? json.campaign : json
  if (record.id === undefined && record.name === undefined && record.status === undefined) return { unknown: null }
  return { ledger: ledgerOf(campaign, record, json) }
}

/** The arm's do-not-contact list, counted (its `entries` or `list`); null when it does not answer with one. */
async function doNotContactOf(call: ConnectionsCall): Promise<number | null> {
  try {
    const json = jsonAnswer(await call(CAMPAIGNS_TOOL, { action: 'dnc' }))
    if (!json || json.error !== undefined) return null
    const list = Array.isArray(json.entries) ? json.entries : Array.isArray(json.list) ? json.list : null
    return list ? list.length : null
  } catch {
    return null
  }
}

/** The ledgers of a routine's campaigns, asked one at a time. When no campaign answers at all (no Connections server, or every
 *  answer a refusal), the answer says why in `error` and names no campaign missing: it could not be read. */
async function ask(id: string, campaigns: string[], call: ConnectionsCall, at: number): Promise<RoutineCampaigns> {
  const ledgers: CampaignLedger[] = []
  const missing: string[] = []
  const failed: string[] = []
  let refused = 0
  for (const campaign of campaigns) {
    const found = await lookup(call, campaign)
    if ('ledger' in found) ledgers.push(found.ledger)
    else if ('failed' in found) failed.push(found.failed)
    else {
      missing.push(campaign)
      if (found.unknown !== null) refused++
    }
  }
  if (ledgers.length === 0 && failed.length + refused === campaigns.length) {
    const why = failed[0] ?? `the Campaigns arm refused ${missing.join(', ')}`
    return { id, campaigns: [], missing: [], doNotContact: null, readAt: null, error: why }
  }
  return {
    id,
    campaigns: ledgers,
    missing,
    doNotContact: await doNotContactOf(call),
    readAt: at,
    error: failed[0] ?? null,
  }
}

export interface CampaignsReader {
  /** The ledgers of the campaigns a routine names (`campaigns`), its answer kept CAMPAIGNS_CACHE_MS unless `fresh`. */
  read(id: string, campaigns: string[], fresh: boolean): Promise<RoutineCampaigns>
}

/** The reader for this Desk: `call` is the person's Connections server (plugins/73-routines.ts), `clock` the manager's clock. */
export function campaignsReader(call: ConnectionsCall, clock: () => number): CampaignsReader {
  const kept = new Map<string, { ids: string; at: number; answer: RoutineCampaigns }>()
  return {
    async read(id, campaigns, fresh) {
      if (campaigns.length === 0) return { id, campaigns: [], missing: [], doNotContact: null, readAt: null, error: null }
      const ids = campaigns.join(',')
      const now = clock()
      const hit = kept.get(id)
      if (!fresh && hit && hit.ids === ids && now - hit.at < CAMPAIGNS_CACHE_MS) return hit.answer
      const answer = await ask(id, campaigns, call, now)
      kept.delete(id)
      kept.set(id, { ids, at: now, answer })
      if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value as string)
      return answer
    },
  }
}

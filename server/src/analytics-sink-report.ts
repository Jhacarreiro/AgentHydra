// WHY: the spend report says how much and where; this says WHY a session was expensive. Five
// lenses on the same weighted total, each tagged structural (configuration) or behavioral (how the
// sessions were run), with the evidence basis and a one-line fix.
// The idea (dead-skill load, deep-context turns, subagent pressure, cache efficiency) comes from
// the learn report in JuliusBrussee/caveman; no code was copied, this is written fresh against
// AgentHydra's own stored per-session totals.

import {
  ANALYTICS_VERSION,
  type AnalyticsRow,
  accountBySession,
  addTokens,
  analyticsCoverage,
  dayKey,
  emptyTokens,
  parseJson,
  selectRows,
  storedModelSpend,
} from './analytics'
import { DEEP_CONTEXT_TOKENS, mcpServerOfTool, type StoredSinks } from './analytics-sinks'
import { db } from './db'
import { instanceSessionMap } from './instance-sessions'
import type { ModelSpend, TokenBreakdown, TokenSink, TokenSinkReport } from './types'
import {
  modelMultiplier,
  W_CACHE_READ,
  W_CACHE_WRITE_1H,
  W_CACHE_WRITE_5M,
  W_OUTPUT,
} from './usage-tokens'

const SINK_FIXES: Record<TokenSink['id'], string> = {
  'dead-skills':
    'Uninstall the skills these sessions never invoke, or scope them to the projects that do: each one is re-read on every call.',
  'dead-mcp':
    'Disable MCP servers these sessions never call, or scope them per project: their instructions and tool names ride along on every call.',
  'deep-context': `Compact or start a fresh session before the prompt passes ${DEEP_CONTEXT_TOKENS / 1000}k tokens: every call past it re-reads the whole history. Counted: only the part read past the line.`,
  // The largest kind on the meter (31x a cache read per token; 43% of the weight on 2026-10-06)
  // and in no other sink, so without it the list hid where most of the weight went.
  output:
    'Use a lower effort and a smaller model for routine work, and ask for short replies: reply and thinking tokens weigh the most per token of anything on the meter.',
  subagents:
    'Spawn subagents for wide, parallel searches only: each one pays for its own prefix and history.',
  // Every cache write, each session's first unavoidable one included, so this is an upper bound on
  // what the fix can save, not the avoidable part alone.
  'cache-writes':
    'Keep gaps between turns inside the cache window and avoid editing instructions mid-session: each session pays one cache write it cannot avoid, and every rewrite after it is billed at a premium.',
}

const selectListing = db.query<{ entries_json: string }, [string]>(
  'select entries_json from skill_listings where hash = ?',
)

interface LoadAcc {
  loadTokens: number
  sessionsLoaded: number
  sessionsUsed: number
  uses: number
  deadTokens: number
}

function foldLoad(
  into: Map<string, LoadAcc>,
  key: string,
  loadTokens: number,
  uses: number,
  calls: number,
): void {
  const r = into.get(key) ?? {
    loadTokens: 0,
    sessionsLoaded: 0,
    sessionsUsed: 0,
    uses: 0,
    deadTokens: 0,
  }
  r.loadTokens = Math.max(r.loadTokens, loadTokens)
  r.sessionsLoaded++
  r.uses += uses
  if (uses > 0) r.sessionsUsed++
  else r.deadTokens += loadTokens * calls
  into.set(key, r)
}

const rankLoad = (m: Map<string, LoadAcc>) =>
  [...m.entries()]
    .map(([key, r]) => ({ key, ...r, deadTokens: Math.round(r.deadTokens) }))
    .sort((a, b) => b.deadTokens - a.deadTokens || b.loadTokens - a.loadTokens)
    .slice(0, 30)

/**
 * Where the window's tokens went, ranked.
 *
 * Windowed per session, on its last turn (like the activity report): a session counts whole when
 * it was active inside the window. The spend panel reads the toolkit per call instead, so the two
 * totals can differ at the window's edge. Dead load is an ESTIMATE: the injected text's length at
 * four characters a token, re-read on every call at the cache-read rate of the model that made the
 * call. The rest is measured off recorded usage.
 */
export function sinkReport(opts: { sinceMs?: number | null } = {}): TokenSinkReport {
  const since = opts.sinceMs ?? null
  const listings = new Map<string, Record<string, number>>()
  const listing = (hash: string): Record<string, number> => {
    let entries = listings.get(hash)
    if (!entries) {
      entries = parseJson<Record<string, number>>(selectListing.get(hash)?.entries_json ?? null, {})
      listings.set(hash, entries)
    }
    return entries
  }
  const accounts = accountBySession()
  let instances = new Map<string, string>()
  try {
    instances = instanceSessionMap()
  } catch {
    // No desktop instances to attribute to: every session falls in the unlinked bucket.
  }
  const lookups: SinkLookups = { listing, accounts, instances }

  const acc: SinkAcc = {
    skills: new Map(),
    servers: new Map(),
    cache: new Map(),
    sessions: 0,
    calls: 0,
    totalWeighted: 0,
    deadSkills: 0,
    deadMcp: 0,
    cacheWrites: 0,
    deepCalls: 0,
    deepWeighted: 0,
    deepExcess: 0,
    output: 0,
    subWeighted: 0,
    spawns: 0,
  }

  for (const row of selectRows.all()) {
    const windowed = sinkRowInWindow(row, since)
    if (windowed) foldSinkRow(row, windowed.scale, windowed.tokens, acc, lookups)
  }

  return sinkReportOf(acc)
}

/** Every running total sinkReport builds across the window's sessions. */
interface SinkAcc {
  skills: Map<string, LoadAcc>
  servers: Map<string, LoadAcc>
  cache: Map<string | null, { sessions: number; cacheRead: number; prompt: number }>
  sessions: number
  calls: number
  totalWeighted: number
  deadSkills: number
  deadMcp: number
  cacheWrites: number
  deepCalls: number
  deepWeighted: number
  deepExcess: number
  output: number
  subWeighted: number
  spawns: number
}

/** What sinkReport looks a session up in: skill listings by hash, and its account. */
interface SinkLookups {
  listing: (hash: string) => Record<string, number>
  accounts: Map<string, string>
  instances: Map<string, string>
}

/** The share of the session's weighted tokens spent on days inside the window (null: no day data). */
function sinkDayShare(daysJson: string | null, since: number | null): number | null {
  if (since === null) return 1
  const sinceDay = dayKey(since)
  let total = 0
  let inWindow = 0
  for (const [day, weighted] of Object.entries(parseJson<Record<string, number>>(daysJson, {}))) {
    total += weighted
    if (day >= sinceDay) inWindow += weighted
  }
  return total > 0 ? inWindow / total : null
}

/** The row's in-window share with its per-model spend scaled to it, or null when the row is out of
 *  the window or has no sink data. A row without day data falls back to its last turn. */
function sinkRowInWindow(
  row: AnalyticsRow,
  since: number | null,
): { scale: number; tokens: Record<string, ModelSpend> } | null {
  if (row.analytics_version !== ANALYTICS_VERSION || !row.sinks_json) return null
  const share = sinkDayShare(row.days_json, since)
  if (share === null) {
    if (since !== null && (row.last_ts ?? 0) < since) return null
  } else if (share <= 0) return null
  const scale = share ?? 1
  const stored = storedModelSpend(row.tokens_json)
  if (Object.keys(stored).length === 0) return null
  const tokens: Record<string, ModelSpend> = {}
  for (const [model, m] of Object.entries(stored))
    tokens[model] =
      scale >= 1
        ? m
        : {
            ...m,
            weighted: m.weighted * scale,
            output: m.output * scale,
            turns: Math.round(m.turns * scale),
            input: m.input * scale,
            cacheRead: m.cacheRead * scale,
            cacheCreation5m: m.cacheCreation5m * scale,
            cacheCreation1h: m.cacheCreation1h * scale,
          }
  return { scale, tokens }
}

/** Fold one in-window session into every sink total. */
function foldSinkRow(
  row: AnalyticsRow,
  scale: number,
  tokens: Record<string, ModelSpend>,
  acc: SinkAcc,
  lookups: SinkLookups,
): void {
  const s = parseJson<Partial<StoredSinks>>(row.sinks_json, {})
  acc.sessions++

  const { sessionCalls, prefixRate, t } = foldSinkModels(tokens, acc)
  acc.calls += sessionCalls

  foldSkillSinks(s, lookups.listing, sessionCalls, prefixRate, acc)
  const tools = parseJson<Record<string, number>>(row.tools_json, {})
  foldMcpSinks(s, tools, sessionCalls, prefixRate, acc)

  acc.deepCalls += (s.deepCalls ?? 0) * scale
  acc.deepWeighted += (s.deepWeighted ?? 0) * scale
  acc.deepExcess += (s.deepExcess ?? 0) * scale
  acc.subWeighted += (s.subWeighted ?? 0) * scale
  // Task is the older name of the Agent tool; both spawn a subagent.
  acc.spawns += ((tools.Task ?? 0) + (tools.Agent ?? 0)) * scale

  const account =
    lookups.accounts.get(row.session_id) ?? lookups.instances.get(row.session_id) ?? null
  const c = acc.cache.get(account) ?? { sessions: 0, cacheRead: 0, prompt: 0 }
  c.sessions++
  c.cacheRead += t.cacheRead
  c.prompt += t.input + t.cacheRead + t.cacheWrite
  acc.cache.set(account, c)
}

/**
 * A session's calls and prefix rate, and its token breakdown. Per model, because a prefix token
 * re-read by Opus costs more than one re-read by Sonnet (modelMultiplier).
 */
function foldSinkModels(
  tokens: Record<string, ModelSpend>,
  acc: SinkAcc,
): { sessionCalls: number; prefixRate: number; t: TokenBreakdown } {
  let sessionCalls = 0
  let prefixRate = 0 // weighted cost of carrying ONE prefix token through this session
  const t = emptyTokens()
  for (const [model, m] of Object.entries(tokens)) {
    const mult = modelMultiplier(model)
    sessionCalls += m.turns
    prefixRate += m.turns * W_CACHE_READ * mult
    acc.cacheWrites +=
      (m.cacheCreation5m * W_CACHE_WRITE_5M + m.cacheCreation1h * W_CACHE_WRITE_1H) * mult
    acc.output += m.output * W_OUTPUT * mult
    acc.totalWeighted += m.weighted
    addTokens(t, m)
  }
  return { sessionCalls, prefixRate, t }
}

/** Each skill the session's listings loaded, and the dead load of the ones it never used. */
function foldSkillSinks(
  s: Partial<StoredSinks>,
  listing: (hash: string) => Record<string, number>,
  sessionCalls: number,
  prefixRate: number,
  acc: SinkAcc,
): void {
  const loaded = new Map<string, number>()
  for (const hash of s.listings ?? [])
    for (const [name, n] of Object.entries(listing(hash)))
      loaded.set(name, Math.max(loaded.get(name) ?? 0, n))
  for (const [name, n] of loaded) {
    const uses = s.skillUses?.[name] ?? 0
    foldLoad(acc.skills, name, n, uses, sessionCalls)
    if (uses === 0) acc.deadSkills += n * prefixRate
  }
}

/** Each MCP server the session loaded, and the dead load of the ones it never called. */
function foldMcpSinks(
  s: Partial<StoredSinks>,
  tools: Record<string, number>,
  sessionCalls: number,
  prefixRate: number,
  acc: SinkAcc,
): void {
  const serverCalls = new Map<string, number>()
  for (const [tool, n] of Object.entries(tools)) {
    const server = mcpServerOfTool(tool)
    if (server) serverCalls.set(server, (serverCalls.get(server) ?? 0) + n)
  }
  for (const [server, n] of Object.entries(s.mcpLoad ?? {})) {
    const uses = serverCalls.get(server) ?? 0
    foldLoad(acc.servers, server, n, uses, sessionCalls)
    if (uses === 0) acc.deadMcp += n * prefixRate
  }
}

function tokenSink(
  id: TokenSink['id'],
  kind: TokenSink['kind'],
  basis: TokenSink['basis'],
  weighted: number,
  totalWeighted: number,
): TokenSink {
  return {
    id,
    kind,
    basis,
    weighted: Math.round(weighted),
    share: totalWeighted > 0 ? weighted / totalWeighted : 0,
    fix: SINK_FIXES[id],
  }
}

/** The report the folded totals make, sinks ranked by weight. */
function sinkReportOf(acc: SinkAcc): TokenSinkReport {
  const total = acc.totalWeighted
  return {
    sessions: acc.sessions,
    calls: Math.round(acc.calls),
    totalWeighted: Math.round(total),
    sinks: [
      tokenSink('dead-skills', 'structural', 'estimated', acc.deadSkills, total),
      tokenSink('dead-mcp', 'structural', 'estimated', acc.deadMcp, total),
      tokenSink('deep-context', 'behavioral', 'measured', acc.deepExcess, total),
      tokenSink('output', 'behavioral', 'measured', acc.output, total),
      tokenSink('subagents', 'behavioral', 'measured', acc.subWeighted, total),
      tokenSink('cache-writes', 'behavioral', 'measured', acc.cacheWrites, total),
    ].sort((a, b) => b.weighted - a.weighted),
    skills: rankLoad(acc.skills),
    mcpServers: rankLoad(acc.servers),
    deepContext: {
      threshold: DEEP_CONTEXT_TOKENS,
      calls: Math.round(acc.deepCalls),
      weighted: Math.round(acc.deepWeighted),
      excess: Math.round(acc.deepExcess),
    },
    subagents: { weighted: Math.round(acc.subWeighted), spawns: Math.round(acc.spawns) },
    cacheByAccount: [...acc.cache.entries()]
      .map(([key, c]) => ({
        key,
        sessions: c.sessions,
        cacheRead: Math.round(c.cacheRead),
        prompt: Math.round(c.prompt),
        ratio: c.prompt > 0 ? c.cacheRead / c.prompt : 0,
      }))
      .sort((a, b) => b.prompt - a.prompt),
    coverage: analyticsCoverage(),
  }
}

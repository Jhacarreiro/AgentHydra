import { ROUTINES_EVERY_MS, type Routine, type RoutineDetails, type RoutinesStatus } from '@shared/routines'
import { emptyMemory, judge, lastEndOf, type Seen } from './decide'
import { kindOf } from './manifest'
import { pageOf, readHistory, statsOf, sumCounters } from './history'
import { message } from './proc'
import { enabled, historyFile, keepHistory, type Manager } from './manager'
import { settleCommands } from './manager-settle'
import { look } from './manager-look'
import { refreshCentral, storeStatus } from './manager-central'

function routineView(m: Manager, s: Seen, t: number): Routine {
  const { entry } = s
  const def = entry.def
  const mem = m.memory[entry.id] ?? emptyMemory()
  const j = judge(s, mem, t, enabled(m), false)
  return {
    id: entry.id,
    name: def?.name ?? (entry.def === null ? entry.name : undefined) ?? entry.id,
    kind: def ? kindOf(def) : null,
    state: j.state,
    reason: j.reason,
    askedBy: def?.askedBy ?? null,
    schedule: def?.schedule ?? null,
    windowsTask: def?.windowsTask ?? null,
    what: def?.run !== undefined ? 'run' : def?.prompt !== undefined ? 'prompt' : null,
    prompt: def?.prompt ?? null,
    command: def?.run ?? null,
    statusCommand: def?.status ?? null,
    cwd: def?.cwd ?? null,
    timeoutMinutes: def?.timeoutMinutes ?? null,
    until: def?.until ?? null,
    paused: def?.windowsTask !== undefined ? s.task?.state === 'Disabled' : mem.paused,
    describe: def?.describe === true,
    modes: def?.modes ? [...def.modes.options] : null,
    mode: def?.modes && s.reading?.mode && def.modes.options.includes(s.reading.mode) ? s.reading.mode : null,
    headline: s.reading?.headline ?? null,
    totals: s.reading?.totals ?? null,
    settings: s.reading?.settings ?? null,
    lastRunAt: def?.windowsTask !== undefined ? (mem.runs[0]?.endedAt ?? null) : lastEndOf(s.reading, mem),
    nextRunAt: j.nextRunAt,
    running: mem.running ? { ...mem.running } : null,
    runs: [...mem.runs],
    runsTotal: Math.max(mem.runs.length, m.runCounts.get(entry.id) ?? 0),
    ...(entry.central ? { source: 'central' as const, runsOn: entry.central.runsOn } : {}),
  }
}

export function status(m: Manager): RoutinesStatus {
  const t = m.clock()
  return {
    enabled: enabled(m),
    everyMs: ROUTINES_EVERY_MS,
    checkedAt: m.checkedAt,
    nextCheckAt: m.nextCheckAt,
    routines: m.seen.map((s) => routineView(m, s, t)),
    proposals: m.proposals,
    error: m.lastError,
    store: storeStatus(m.central, m.centralError),
  }
}

/** One routine's details: a page of its runs (`before` pages back, `limit` sizes it, at most 500), its stats and counters.
 *  Null when there is no such routine. */
export function detailsFor(m: Manager, id: string, before: string | undefined, limit: string | undefined): RoutineDetails | null {
  const s = m.seen.find((x) => x.entry.id === id)
  if (!s && !m.memory[id]) return null
  const mem = m.memory[id]
  if (mem) keepHistory(m, id, mem)
  const all = readHistory(historyFile(m, id))
  const beforeQ = Number(before)
  const limitQ = Number(limit)
  const pageSize = Number.isFinite(limitQ) && limitQ >= 1 ? Math.min(Math.floor(limitQ), 500) : 50
  const page = pageOf(all, Number.isFinite(beforeQ) && before ? beforeQ : null, pageSize)
  const r = s?.reading
  return {
    id,
    name: s?.entry.def?.name ?? (s && s.entry.def === null ? s.entry.name : undefined) ?? id,
    runs: page.runs,
    nextBefore: page.nextBefore,
    stats: statsOf(all, m.clock()),
    counters: sumCounters(all),
    totals: r?.totals ?? null,
    headline: r?.headline ?? null,
    numbers: r?.numbers ?? null,
    trends: r?.trends ?? null,
  }
}

/** GET /api/routines: the last look's view, or a fresh look when asked for one or when none has run yet. A fresh look reads
 *  the central store first. */
export async function readRoutines(m: Manager, fresh: boolean): Promise<RoutinesStatus> {
  if (fresh && m.central) await refreshCentral(m.central, true, m.clock())
  if (m.checkedAt === null || fresh) await look(m)
  else
    await settleCommands(m).catch((err) => {
      m.lastError = `reading the runs failed: ${message(err)}`
      console.error('[routines] reading the runs failed:', err)
    })
  return status(m)
}

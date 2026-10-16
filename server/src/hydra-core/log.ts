import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { logPath } from './paths'

const ROTATE_BYTES = 20 * 1024 * 1024
const ROTATED = /^log-(\d{4}-\d{2})(?:-(\d+))?\.jsonl$/

/** The month (YYYY-MM) of the log's first line, or null for an empty or unreadable one. */
function firstMonth(file: string): string | null {
  const buf = Buffer.alloc(64)
  const fd = openSync(file, 'r')
  try {
    const n = readSync(fd, buf, 0, buf.length, 0)
    return /"at":"(\d{4}-\d{2})/.exec(buf.toString('utf8', 0, n))?.[1] ?? null
  } finally {
    closeSync(fd)
  }
}

/** Moves log.jsonl to log-YYYY-MM.jsonl (its first line's month) when a new month starts or it passes 20 MB. */
function rotate(dir: string, now: Date): void {
  const file = logPath(dir)
  if (!existsSync(file)) return
  const size = statSync(file).size
  if (!size) return
  const month = firstMonth(file)
  if (!month || (month === now.toISOString().slice(0, 7) && size < ROTATE_BYTES)) return
  let target = join(dir, `log-${month}.jsonl`)
  for (let n = 2; existsSync(target); n++) target = join(dir, `log-${month}-${n}.jsonl`)
  renameSync(file, target)
}

export function appendLog(dir: string, event: Record<string, unknown>, now = new Date()): void {
  mkdirSync(dir, { recursive: true })
  try {
    rotate(dir, now)
  } catch {
    // Another process holds log.jsonl (Windows refuses the rename): the next append tries again.
  }
  appendFileSync(logPath(dir), `${JSON.stringify({ at: now.toISOString(), ...event })}\n`)
}

/** The month before an ISO timestamp's month: a rotation that was blocked files a new month's first lines under it. */
function monthBefore(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

/** The log's events, oldest first; with `since`, the files from the month before it on and the lines at or after it. */
export function readLog(
  dir: string,
  since?: Date,
): { events: Record<string, unknown>[]; corrupt: number } {
  const events: Record<string, unknown>[] = []
  let corrupt = 0
  const from = since?.toISOString()
  const rotated = existsSync(dir)
    ? readdirSync(dir)
        .map((name) => {
          const m = ROTATED.exec(name)
          return { name, month: m?.[1], n: Number(m?.[2] ?? 1) }
        })
        .filter((f): f is { name: string; month: string; n: number } => Boolean(f.month))
        .filter((f) => !from || f.month >= monthBefore(from))
        .sort((a, b) => a.month.localeCompare(b.month) || a.n - b.n)
        .map((f) => join(dir, f.name))
    : []
  for (const file of [...rotated, logPath(dir)]) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Record<string, unknown>
        if (!from || String(e.at ?? '') >= from) events.push(e)
      } catch {
        corrupt++
      }
    }
  }
  return { events, corrupt }
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1
}

/** The counters statsOf fills in while it walks the events. */
interface Tally {
  misses: Record<string, number>
  noneMisses: Record<string, number>
  overruled: Record<string, number>
  questions: Record<string, { asked: number; defaulted: number }>
  pushback: Record<string, number>
  finds: { total: number; empty: number }
  runs: Set<string>
  reported: Set<string>
  reports: number
}

function tallyMiss(t: Tally, id: string, why: unknown): void {
  bump(t.misses, id)
  if (why === 'none') bump(t.noneMisses, id)
}

function tallyFind(t: Tally, e: Record<string, unknown>): void {
  t.finds.total++
  if (Array.isArray(e.ids) ? e.ids.length === 0 : e.empty === true) t.finds.empty++
}

function tallyQuestion(t: Tally, step: string, defaulted: boolean): void {
  const q = t.questions[step] ?? { asked: 0, defaulted: 0 }
  t.questions[step] = q
  q.asked++
  if (defaulted) q.defaulted++
}

function tallyReport(t: Tally, e: Record<string, unknown>, chat: string): void {
  t.reports++
  if (typeof e.run === 'number') t.reported.add(`${chat}#${e.run}`)
  for (const id of (e.overruled as string[] | undefined) ?? []) bump(t.overruled, id)
}

/** Counts one event into the tally; an event no counter reads is skipped. */
function tallyEvent(t: Tally, e: Record<string, unknown>): void {
  const chat = typeof e.chat === 'string' ? e.chat : ''
  if (e.event === 'miss' && typeof e.id === 'string') tallyMiss(t, e.id, e.why)
  if (e.event === 'find') tallyFind(t, e)
  if (e.event === 'president-block') bump(t.pushback, chat)
  if (e.step === 'start') t.runs.add(`${chat}#${e.run}`)
  else if (typeof e.step === 'string' && e.step !== 'end' && 'answer' in e)
    tallyQuestion(t, e.step, e.defaulted === true)
  if (e.event === 'report') tallyReport(t, e, chat)
}

export function statsOf(dir: string, since?: Date) {
  const { events, corrupt } = readLog(dir, since)
  const t: Tally = {
    misses: {},
    noneMisses: {},
    overruled: {},
    questions: {},
    pushback: {},
    finds: { total: 0, empty: 0 },
    runs: new Set<string>(),
    reported: new Set<string>(),
    reports: 0,
  }
  for (const e of events) tallyEvent(t, e)
  const done = [...t.runs].filter((k) => t.reported.has(k)).length
  return {
    misses: t.misses,
    noneMisses: t.noneMisses,
    overruled: t.overruled,
    reports: t.reports,
    reportRate: {
      runs: t.runs.size,
      reported: done,
      rate: t.runs.size ? Math.round((done / t.runs.size) * 1000) / 1000 : 0,
    },
    questions: t.questions,
    pushback: t.pushback,
    finds: t.finds,
    corrupt,
  }
}

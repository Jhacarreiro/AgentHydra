import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** What the orchestrator has done about stuck workers, kept in a file so a restart neither repeats an act nor forgets a retry. */
export interface StuckRecord {
  /** "<worker id>|<reason>" -> already acted on (a nudge or a cancel), kept in a file so a restart does not repeat it. */
  done: Set<string>
  /** "<worker id>|<reason>" -> failed attempts so far and the earliest time of the next one. */
  retry: Map<string, { fails: number; next: number }>
  save: () => void
}

/** Reads the record a previous run left in `stuckFile`; a missing or unreadable file leaves it empty. */
export function loadStuckRecord(stuckFile: string | null): StuckRecord {
  const done = new Set<string>()
  const retry = new Map<string, { fails: number; next: number }>()
  try {
    const saved = stuckFile ? (JSON.parse(readFileSync(stuckFile, 'utf8')) as { done?: string[]; retry?: Record<string, { fails: number; next: number }> } | string[]) : null
    if (Array.isArray(saved)) for (const k of saved) done.add(k)
    else if (saved) {
      for (const k of saved.done ?? []) done.add(k)
      for (const [k, v] of Object.entries(saved.retry ?? {})) retry.set(k, v)
    }
  } catch {
    /* no record yet */
  }
  const save = (): void => {
    try {
      if (!stuckFile) return
      mkdirSync(dirname(stuckFile), { recursive: true })
      writeFileSync(stuckFile, JSON.stringify({ done: [...done], retry: Object.fromEntries(retry) }))
    } catch {
      /* kept in memory for this run */
    }
  }
  return { done, retry, save }
}

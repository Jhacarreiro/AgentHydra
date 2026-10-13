import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { logPath } from './paths'

export function appendLog(dir: string, event: Record<string, unknown>, now = new Date()): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(logPath(dir), `${JSON.stringify({ at: now.toISOString(), ...event })}\n`)
}

export function readLog(dir: string): { events: Record<string, unknown>[]; corrupt: number } {
  const file = logPath(dir)
  const events: Record<string, unknown>[] = []
  let corrupt = 0
  if (!existsSync(file)) return { events, corrupt }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      corrupt++
    }
  }
  return { events, corrupt }
}

export function statsOf(dir: string) {
  const { events, corrupt } = readLog(dir)
  const misses: Record<string, number> = {}
  const overruled: Record<string, number> = {}
  let reports = 0
  for (const e of events) {
    if (e.event === 'miss' && typeof e.id === 'string') misses[e.id] = (misses[e.id] ?? 0) + 1
    if (e.event === 'report') {
      reports++
      for (const id of (e.overruled as string[] | undefined) ?? [])
        overruled[id] = (overruled[id] ?? 0) + 1
    }
  }
  return { misses, overruled, reports, corrupt }
}

// What the browser tools service last did with each profile folder, for the idle close that runs in Desk: the time of the
// last tool call against it and how many calls are running on it now. Only the service writes the file; Desk reads it.

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface DirActivity {
  last: number
  busy: number
}

interface ActivityFile {
  pid: number
  dirs: Record<string, DirActivity>
}

const calls = new AsyncLocalStorage<Set<string>>()
const dirs = new Map<string, DirActivity>()
let filePath: string | null = null

export const activityPath = (home: string): string => join(home, 'browser-agent', 'activity.json')

export function setActivityHome(home: string): void {
  filePath = activityPath(home)
}

function flush(): void {
  if (!filePath) return
  mkdirSync(join(filePath, '..'), { recursive: true })
  const body: ActivityFile = { pid: process.pid, dirs: Object.fromEntries(dirs) }
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(body), 'utf8')
  renameSync(tmp, filePath)
}

function entry(dir: string): DirActivity {
  const key = resolve(dir)
  let row = dirs.get(key)
  if (!row) {
    row = { last: 0, busy: 0 }
    dirs.set(key, row)
  }
  return row
}

/** Runs one tool call; every profile it touches counts as busy until the call answers, and as used at that moment. */
export async function withCall<T>(run: () => Promise<T>): Promise<T> {
  const touched = new Set<string>()
  try {
    return await calls.run(touched, run)
  } finally {
    for (const dir of touched) {
      const row = entry(dir)
      row.busy = Math.max(0, row.busy - 1)
      row.last = Date.now()
    }
    if (touched.size > 0) flush()
  }
}

/** Marks a profile folder as used by the call in progress; outside a call it only stamps the time. */
export function noteUse(dir: string): void {
  const touched = calls.getStore()
  const row = entry(dir)
  row.last = Date.now()
  if (touched && !touched.has(resolve(dir))) {
    touched.add(resolve(dir))
    row.busy += 1
  }
  flush()
}

/** Desk's view: the calls running on a folder count only while the service that wrote them is alive. */
export function readActivity(home: string): Map<string, DirActivity> {
  const out = new Map<string, DirActivity>()
  const path = activityPath(home)
  if (!existsSync(path)) return out
  let file: ActivityFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as ActivityFile
  } catch {
    return out
  }
  const alive = pidAlive(file.pid)
  for (const [dir, row] of Object.entries(file.dirs ?? {})) {
    out.set(resolve(dir), { last: Number(row.last) || 0, busy: alive ? Number(row.busy) || 0 : 0 })
  }
  return out
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

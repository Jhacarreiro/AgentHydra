import type { Scan, TopFile } from './model.mjs'
import type { Snapshot } from './history.mjs'

export interface TrimPick {
  page: string
  route: string | null
  points: number
  exposure: number | null
  describe: string
  topFiles: TopFile[]
  brief: string
}

export function nextTrim(
  scan: Scan,
  history?: Snapshot[],
  options?: { now?: number; cli?: string },
): TrimPick | null

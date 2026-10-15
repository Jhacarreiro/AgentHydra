import type { Scan } from './model.mjs'

export interface HistoryPage {
  page: string
  points: number
  units: Record<string, number>
}

export interface Snapshot {
  at: string
  root: string
  repo: string
  mode: string
  total: number
  pages: HistoryPage[]
}

export interface Progress {
  first: { at: string; total: number }
  now: { at: string; total: number }
  dropped: number
  pagesCheaper: number
  biggestDrops: { page: string; from: number; to: number }[]
  unitsFell: Record<string, number>
}

export function historyFile(): string
export function snapshotOf(scan: Scan, at?: string): Snapshot
export function recordScan(scan: Scan, at?: string): { written: boolean; snapshot: Snapshot }
export function readHistory(root: string): Snapshot[]
export function progress(root: string): Progress | null

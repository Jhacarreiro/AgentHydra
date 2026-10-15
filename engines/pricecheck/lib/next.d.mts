import type { Scan, TopFile } from './model.mjs'
import type { Snapshot } from './history.mjs'

export interface CandidatePage {
  page: string
  route: string | null
  points: number
  exposure: number | null
  offPoints: number
}

export interface Candidate {
  kind: 'page' | 'file'
  file: string
  points: number
  offPoints: number
  /** For a shared file: its uses summed over the pages. */
  uses?: number
  pages?: CandidatePage[]
}

export interface TrimPick {
  page: string | null
  route: string | null
  points: number
  exposure: number | null
  describe: string
  topFiles: TopFile[]
  candidate: Candidate
  adviceId: string
  claim: string
  brief: string
}

export function nextTrim(
  scan: Scan,
  history?: Snapshot[],
  options?: { now?: number; cli?: string; adviceId?: string },
): TrimPick | null

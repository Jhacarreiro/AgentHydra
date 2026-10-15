export interface Price {
  weight: number
  free: number
}

export type PriceList = Record<string, Price>

export type Reach = 'own' | 'kit' | 'off'

export interface Item {
  unit: string
  count: number
  file: string
  reach?: Reach
  line?: number
  note?: string
}

export interface Unit extends Price {
  what: string
}

export const UNITS: { [unit: string]: Unit }
export const UNIT_NAMES: string[]
export function priceList(overrides?: Record<string, number | Partial<Price>>): PriceList
export const PRICE_LIST_VERSION: number
export const OFF_FACTOR: number
export function rollup(
  items: Item[],
  list?: PriceList,
  opts?: { offFactor?: number; uses?: Record<string, number> },
): { points: number; units: Record<string, number>; byFile: Record<string, ScanFile>; offPoints: number; offByFile: Record<string, number> }

export interface ScanFile {
  points: number
  units: Record<string, number>
  /** How many times the page's render tree renders this file; absent in older results. */
  uses?: number
}

export interface ScanPage {
  page: string
  route?: string
  points: number
  units: Record<string, number>
  byFile: Record<string, ScanFile>
  offPoints?: number
  offByFile?: Record<string, number>
  views?: unknown
  exposure?: number
}

export interface Scan {
  root: string
  mode: string
  pages: ScanPage[]
}

export interface TopFile extends ScanFile {
  file: string
}

export function describe(page: ScanPage, list?: unknown): string
export function topFiles(page: ScanPage, n?: number): TopFile[]

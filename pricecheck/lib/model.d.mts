export interface Price {
  weight: number
  free: number
}

export type PriceList = Record<string, Price>

export interface Item {
  unit: string
  count: number
  file: string
  line?: number
  note?: string
}

export interface Unit extends Price {
  what: string
}

export const UNITS: { [unit: string]: Unit }
export const UNIT_NAMES: string[]
export function priceList(overrides?: Record<string, number | Partial<Price>>): PriceList
export function rollup(
  items: Item[],
  list?: PriceList,
): { points: number; units: Record<string, number>; byFile: Record<string, ScanFile> }

export interface ScanFile {
  points: number
  units: Record<string, number>
}

export interface ScanPage {
  page: string
  route?: string
  points: number
  units: Record<string, number>
  byFile: Record<string, ScanFile>
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

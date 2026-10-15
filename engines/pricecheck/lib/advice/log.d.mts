export interface AdviceItem {
  kind: 'diff' | 'check' | 'tag' | 'next'
  root?: string
  page?: string
  points?: number
  files?: { file: string; points: number }[]
  claim?: string
  id?: string
}

export interface AdviceRow extends AdviceItem {
  type: 'advice'
  id: string
  at: string
  repo?: string
  version: string
  head: string | null
}

export interface CallRow {
  at: string
  cmd: string
  args: string[]
  root: string
  ms: number
  exit: number
  version: string
}

export function homeDir(): string
export function adviceFile(): string
export function callsFile(): string
export function appendRow(file: string, row: object): void
export function readRows<T = any>(file: string): T[]
export function newId(): string
export function pricecheckVersion(): string
export function gitHead(root: string): string | null
export function recordAdvices(items: AdviceItem[]): (string | null)[]
export function recordAdvice(item: AdviceItem): string | null
export function recordCall(call: { cmd: string; args?: string[]; ms: number; exit: number }): void

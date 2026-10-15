import { MODES } from './catalog'
import type { EntryFeedback } from './feedback'

export type Ev = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const ONE_ID = /^(?:person|instrument|worker|knowledge|skill):[a-z0-9][a-z0-9-]*$/

/** The ids a pick step's answer took from the list it was shown: numbers or ids. */
function picked(e: Ev): string[] {
  if (!/pick$/.test(str(e.step)) || !Array.isArray(e.shown)) return []
  const tokens = str(e.answer)
    .split(/[\s,]+/)
    .filter(Boolean)
  if (!tokens.every((t) => /^\d+$/.test(t) || ONE_ID.test(t))) return []
  const shown = e.shown as unknown[]
  return tokens
    .map((t) => (/^\d+$/.test(t) ? shown[Number(t) - 1] : t))
    .filter((id): id is string => typeof id === 'string' && ONE_ID.test(id))
}

export interface Need {
  at: string
  kind: 'none' | 'missing'
  text: string
  need?: string
}

/** The running fold: the per-entry counts, and the maps that tie a take or a report to the run it came from. */
export interface Fold {
  entries: Record<string, EntryFeedback>
  runOf: Map<string, number>
  shownIn: Map<string, Set<string>>
  takenIn: Map<string, Set<string>>
  needs: Need[]
}

export function newFold(): Fold {
  return { entries: {}, runOf: new Map(), shownIn: new Map(), takenIn: new Map(), needs: [] }
}

function of(fold: Fold, id: string): EntryFeedback {
  fold.entries[id] ??= { offered: 0, pasted: 0, taken: 0, rejected: 0, reported: 0 }
  return fold.entries[id]
}

function take(fold: Fold, chat: string, run: number | undefined, ids: string[]): void {
  for (const id of new Set(ids)) {
    of(fold, id).taken++
    if (run === undefined) continue
    const key = `${chat}#${run}`
    const set = fold.takenIn.get(key) ?? new Set<string>()
    set.add(id)
    fold.takenIn.set(key, set)
  }
}

function foldPack(fold: Fold, e: Ev): void {
  if (!(e.event === 'pack' || e.event === 'placement') || !Array.isArray(e.ids)) return
  const pasted = Array.isArray(e.pasted) ? new Set(e.pasted) : null
  for (const id of new Set(e.ids)) {
    if (typeof id !== 'string') continue
    if (pasted ? pasted.has(id) : /^(?:knowledge|person):/.test(id))
      of(fold, id).pasted = (of(fold, id).pasted ?? 0) + 1
    else of(fold, id).offered++
  }
}

function foldFind(fold: Fold, e: Ev): void {
  if (e.event !== 'find' || !Array.isArray(e.ids)) return
  for (const id of new Set(e.ids)) if (typeof id === 'string') of(fold, id).offered++
}

function foldShown(fold: Fold, chat: string, run: number | undefined, e: Ev): void {
  if (!Array.isArray(e.shown)) return
  const key = `${chat}#${run}`
  const seen = fold.shownIn.get(key) ?? new Set<string>()
  fold.shownIn.set(key, seen)
  for (const id of e.shown)
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id)
      of(fold, id).offered++
    }
  take(fold, chat, run, picked(e))
}

function foldMiss(fold: Fold, e: Ev): void {
  if (e.event !== 'miss' || typeof e.id !== 'string') return
  of(fold, e.id).rejected++
  if (e.why === 'none' && str(e.better).trim())
    fold.needs.push({ at: str(e.at), kind: 'none', text: str(e.better).trim(), need: str(e.need) })
}

function foldReport(fold: Fold, chat: string, run: number | undefined, e: Ev): void {
  if (e.event !== 'report') return
  if (typeof e.score === 'number' && run !== undefined)
    for (const id of fold.takenIn.get(`${chat}#${run}`) ?? []) of(fold, id).reported += e.score - 3
  for (const id of Array.isArray(e.overruled) ? e.overruled : [])
    if (typeof id === 'string') of(fold, id).reported--
  if (str(e.missing).trim())
    fold.needs.push({ at: str(e.at), kind: 'missing', text: str(e.missing).trim() })
}

/** Folds one log line into the fold; the order of these steps is the order the counts were always made in. */
export function foldEvent(fold: Fold, e: Ev): void {
  const chat = str(e.chat)
  const run = typeof e.run === 'number' ? e.run : undefined
  if (e.step === 'start' && run !== undefined) fold.runOf.set(chat, run)
  foldPack(fold, e)
  foldFind(fold, e)
  foldShown(fold, chat, run, e)
  if (typeof e.id === 'string' && (MODES as readonly unknown[]).includes(e.mode))
    take(fold, chat, fold.runOf.get(chat), [e.id])
  foldMiss(fold, e)
  foldReport(fold, chat, run, e)
}

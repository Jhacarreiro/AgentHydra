// server/src/hydra-core/lead.ts - who a chat is told to be: the people add-on's model call picks the lead among the managers (or
// none) and the word ranker answers when there is no add-on, no manager, or that call fails or runs out of time.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { contentWords } from '../mcp-find'
import { peopleAddon } from '../people-host'
import { type CatalogEntry, LEAD_TIERS, loadRef, loadText } from './catalog'
import { type Feedback, readFeedback } from './feedback'
import { detailOf, rankEntries, terms } from './find'
import { emptyDoc, leadLine, parseHydra, renderHydra } from './hydra-md'
import { appendLog } from './log'
import { coreDir } from './paths'

/** A chat's first launch may wait this long for the model's pick. */
export const LAUNCH_BUDGET_MS = 5000
/** The hook gives the whole per-message request 1.5 s (hook.mjs PACK_TIMEOUT_MS); the call gets this much of it. */
export const MESSAGE_BUDGET_MS = 1000
/** A per-message shift check that misses MESSAGE_BUDGET_MS keeps asking this long in the background; under 3000 so
 *  it stays one ask. Live picks that missed 1 s came back in 1.0-1.6 s. */
export const LATE_BUDGET_MS = 2500
export const LEAD_MIN = 4
/** A lead-change note carries the new lead's brief whole up to this many characters. */
export const NOTE_CAP = 9500
export interface Decision {
  answer: string | null
  error?: string
}

export interface LeadPick {
  id: string | null
  path: 'model' | 'words'
  ms: number
  error?: string
}

const CACHE_MAX = 100
/** Picks the model made, so a launch that builds its slot twice asks once; a failed call is asked again. */
const cache = new Map<string, LeadPick>()

const late = new Set<Promise<void>>()

/** Resolves once every late pick started so far has landed. */
export async function latePicks(): Promise<void> {
  while (late.size) await Promise.all([...late])
}

/** Forgets the picks the model made (a test's cleanup). */
export function forgetLeadPicks(): void {
  cache.clear()
}

/** Whether a pick can ask a model at all: the add-on answers lead picks, and AGENTHYDRA_LEAD_MODEL is not off. */
export function modelOn(): boolean {
  return !!peopleAddon()?.lead && process.env.AGENTHYDRA_LEAD_MODEL !== 'off'
}

/** The managers a lead is picked from: the people of the manager family that can be become. */
export function managersOf(entries: Iterable<CatalogEntry>): CatalogEntry[] {
  return [...entries]
    .filter(
      (e) =>
        e.kind === 'person' &&
        e.family === 'manager' &&
        e.tier === 'manager' &&
        (e.modes ?? []).includes('become'),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** The manager who takes work spanning several fields. */
export function coordinatorOf(managers: CatalogEntry[]): CatalogEntry | undefined {
  return managers.find((e) => /coordinat/i.test(`${e.title ?? ''} ${e.id}`))
}

const slugOf = (e: CatalogEntry) => e.id.slice(e.id.indexOf(':') + 1)

/** The word ranker: content words only, no `how` text, nothing under LEAD_MIN, and score before tier. Three or
 *  more managers hit means work across fields, so the coordinator. */
export function wordLead(
  entries: CatalogEntry[],
  message: string,
  feedback: Feedback | null = readFeedback(coreDir()),
): CatalogEntry | null {
  if (!contentWords(message).length) return null
  const managers = managersOf(entries)
  const need = terms(message, true)
  const coord = coordinatorOf(managers)
  const fields = managers.filter((m) => m !== coord && detailOf(m, need, true).score >= 2)
  if (coord && fields.length >= 3) return coord
  const ranked = rankEntries(entries, message, {
    kinds: ['person'],
    mode: 'become',
    tiers: LEAD_TIERS,
    content: true,
    noHow: true,
    min: LEAD_MIN,
    feedback,
  })
  return ranked[0]?.entry ?? null
}

/**
 * The lead for a message: the model's pick among the managers or none, else the word ranker's. A message with no
 * content word ("keep going", "ok") needs no call. `log` appends which path chose. `current` is the chat's lead now,
 * named in the question. With `late`, the call may run LATE_BUDGET_MS: the pick still answers by `budgetMs` (the word
 * ranker's when the model is not back), and the model's answer, when it comes, goes to `late` and the log.
 */
export async function pickLead(
  entries: CatalogEntry[],
  message: string,
  budgetMs: number,
  opts: {
    cache?: boolean
    log?: { dir: string; chat: string; at?: Date }
    current?: CatalogEntry | null
    late?: (pick: LeadPick) => void
  } = {},
): Promise<LeadPick> {
  const key = `${budgetMs}
${opts.current?.id ?? ''}
${message}`
  const hit = opts.cache === false ? undefined : cache.get(key)
  if (hit) return hit
  const started = performance.now()
  const managers = managersOf(entries)
  const toPick = (d: Decision): LeadPick => {
    const ms = Math.round(performance.now() - started)
    const answer = d.answer?.trim().toLowerCase()
    const chosen = managers.find((m) => slugOf(m) === answer)
    if (answer === 'none') return { id: null, path: 'model', ms }
    if (chosen) return { id: chosen.id, path: 'model', ms }
    return {
      id: wordLead(entries, message)?.id ?? null,
      path: 'words',
      ms,
      error: d.error ?? `not an option: ${d.answer}`,
    }
  }
  const keep = (pick: LeadPick, extra: Record<string, unknown> = {}, at = opts.log?.at) => {
    if (opts.cache !== false && !pick.error) {
      cache.set(key, pick)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    }
    if (opts.log)
      appendLog(
        opts.log.dir,
        {
          event: 'lead-pick',
          chat: opts.log.chat,
          id: pick.id,
          path: pick.path,
          ms: pick.ms,
          ...(pick.error ? { error: pick.error } : {}),
          ...extra,
        },
        at,
      )
  }
  let pick: LeadPick
  const addon = peopleAddon()
  if (!contentWords(message).length) pick = { id: null, path: 'words', ms: 0 }
  // No managers to choose from, or no one to ask: the word ranker picks among whoever can be become.
  else if (!managers.length || !addon?.lead)
    pick = { id: wordLead(entries, message)?.id ?? null, path: 'words', ms: 0 }
  else {
    const budget = opts.late ? LATE_BUDGET_MS : budgetMs
    const answer: Promise<Decision> = addon
      .lead({ message, entries, current: opts.current?.id ?? null, budgetMs: budget })
      .then((r) => ({ answer: r?.slug ?? 'none' }))
    const asked = answer.catch(
      (err): Decision => ({
        answer: null,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    const then = opts.late
    if (!then) pick = toPick(await asked)
    else {
      let timer: ReturnType<typeof setTimeout> | undefined
      const out = new Promise<null>((r) => {
        timer = setTimeout(() => r(null), Math.max(100, budgetMs - 50))
      })
      const d = await Promise.race([asked, out])
      clearTimeout(timer)
      if (d) pick = toPick(d)
      else {
        pick = toPick({ answer: null, error: 'no answer in time; asking on' })
        const landing: Promise<void> = asked
          .then((ld) => {
            const lp = toPick(ld)
            keep(lp, { late: true }, new Date())
            then(lp)
          })
          .catch((err) => {
            if (opts.log)
              appendLog(opts.log.dir, {
                event: 'lead-pick',
                chat: opts.log.chat,
                late: true,
                error: String(err instanceof Error ? err.message : err).slice(0, 200),
              })
          })
          .finally(() => late.delete(landing))
        late.add(landing)
      }
    }
  }
  keep(pick)
  return pick
}

/** Owner messages that only keep the work going. */
const CONTINUE =
  /^(ok(ay)?|yes|yep|sure|go( on| ahead)?|continue|keep going|do it|thanks?|thank you|sounds good|next|proceed)\b/i

/** An owner message worth checking the lead against: three content words or more, or a continuation that names its
 *  work ("keep going on the ad campaign"); a bare "keep going" or "ok do it" keeps the lead. */
export function substantive(message: string): boolean {
  const m = message.trim()
  return contentWords(m).length >= (CONTINUE.test(m) ? 2 : 3)
}

/** The cheap check before a call: the work may have moved when the current lead matches none of the message's
 *  words, or the word ranker names another lead. */
export function mayHaveMoved(
  entries: CatalogEntry[],
  current: CatalogEntry | null,
  message: string,
): boolean {
  if (!current) return true
  if (detailOf(current, terms(message, true), true).score < 2) return true
  const words = wordLead(entries, message)
  return !!words && words.id !== current.id
}

/** A brief for a note: whole when it fits NOTE_CAP, else the text before its third `## ` heading. */
export function briefFor(e: CatalogEntry, chat: string): string {
  const text = loadText(e).trimEnd()
  const become = `The whole brief: core_use { chat: "${chat}", id: "${e.id}", mode: "become" } (${loadRef(e)}).`
  if (text.length <= NOTE_CAP) return text
  const heads = [...text.matchAll(/^## /gm)].map((m) => m.index ?? 0)
  const head = heads.length >= 3 ? text.slice(0, heads[2]).trimEnd() : text
  const room = NOTE_CAP - become.length - 2
  return `${head.length <= room ? head : head.slice(0, room)}\n\n${become}`
}

/** `late`: the pick came back after the message it was made for, so the note rides the next one. */
export function leadNote(
  from: CatalogEntry | null,
  to: CatalogEntry,
  chat: string,
  late = false,
): string {
  return [
    `Lead change: ${late ? "the owner's last message was" : 'this message is'} ${to.name}'s field${to.title ? ` (${to.title})` : ''}${
      from ? `, not ${from.name}'s` : ''
    }. From here on you are ${to.name}. ${to.name}'s brief:`,
    briefFor(to, chat),
  ].join('\n\n')
}

/** Makes `e` the chat's lead in its hydra.md, as core_use become does; the next launch's slot carries its brief. */
export function recordLead(hydraMd: string, e: CatalogEntry, now: Date): void {
  const doc =
    (existsSync(hydraMd) ? parseHydra(readFileSync(hydraMd, 'utf8')) : null) ?? emptyDoc(now)
  doc.lead = leadLine(e)
  doc.updated = now.toISOString()
  mkdirSync(dirname(hydraMd), { recursive: true })
  writeFileSync(hydraMd, renderHydra(doc))
}

export interface LateLead {
  from: string | null
  to: string
}

const lateFile = (chatRoot: string) => join(chatRoot, 'lead-late.json')

/** A late pick's move whose lead-change note the chat's next message still owes, beside its hydra.md. */
export function setLateLead(chatRoot: string, move: LateLead): void {
  mkdirSync(chatRoot, { recursive: true })
  writeFileSync(lateFile(chatRoot), JSON.stringify(move))
}

/** The owed move, taken once: it is removed as it is read. */
export function takeLateLead(chatRoot: string): LateLead | null {
  const file = lateFile(chatRoot)
  if (!existsSync(file)) return null
  let move: LateLead | null = null
  try {
    move = JSON.parse(readFileSync(file, 'utf8')) as LateLead
  } catch {}
  rmSync(file, { force: true })
  return move?.to ? move : null
}

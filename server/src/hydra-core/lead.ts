// server/src/hydra-core/lead.ts - who a chat is told to be: one small model call through HSwarm's decide door picks
// the lead among the five managers (or none), and the word ranker answers when that call fails or runs out of time.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { contentWords } from '../mcp-find'
import { type CatalogEntry, LEAD_TIERS, loadRef, loadText } from './catalog'
import { detailOf, rankEntries, terms } from './find'
import { emptyDoc, leadLine, parseHydra, renderHydra } from './hydra-md'
import { appendLog } from './log'

/** A chat's first launch may wait this long for the model's pick. */
export const LAUNCH_BUDGET_MS = 5000
/** The hook gives the whole per-message request 1.5 s (hook.mjs PACK_TIMEOUT_MS); the call gets this much of it. */
export const MESSAGE_BUDGET_MS = 1000
export const LEAD_MIN = 4
/** A lead-change note carries the new lead's brief whole up to this many characters. */
export const NOTE_CAP = 9500
const DECIDE_URL = 'http://127.0.0.1:7793/api/decide'
/** Jev and Clef answer nothing on this PC (2026-10-14: the TypeSafe key is disabled, no Cloudflare route), so the
 *  call goes straight to a fast fallback model: this one answered in 0.4-0.7 s. */
const DEFAULT_MODEL = 'cerebras-gpt-oss-120b'
/** One model answer varies run to run: with time for it (a launch), three asks at once and two agreeing measured
 *  steadier; inside the hook's budget one ask, since three at once come back slower. */
const votesFor = (budgetMs: number) => (budgetMs >= 3000 ? 3 : 1)

export interface LeadQuestion {
  message: string
  question: string
  options: Record<string, string>
}

export interface Decision {
  answer: string | null
  error?: string
}

export type Decider = (q: LeadQuestion, budgetMs: number) => Decision

export interface LeadPick {
  id: string | null
  path: 'model' | 'words'
  ms: number
  error?: string
}

/** Asks `o.votes` times at once and answers when a majority agrees, else with the most common answer so far when
 *  every ask is back or the time is up. */
const CHILD = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);let tok;
try{tok=require('fs').readFileSync(o.tokenFile,'utf8').trim()}catch(e){return done({answer:null,error:'no HSwarm token: '+e.message})}
const got=[],errs=[];let back=0,over=false;
function done(v){if(over)return;over=true;process.stdout.write(JSON.stringify(v));process.exit(0)}
function settle(final){const n={};for(const a of got)n[a]=(n[a]||0)+1;
const best=got.slice().sort((a,b)=>n[b]-n[a])[0];
if(best!==undefined&&(n[best]*2>o.votes||final))return done({answer:best,votes:n[best],of:got.length});
if(final)done({answer:null,error:errs[0]||'no answer'})}
setTimeout(()=>settle(true),o.ms);
for(let i=0;i<o.votes;i++)fetch(o.url,{method:'POST',headers:{'content-type':'application/json','x-hswarm-token':tok},body:JSON.stringify(o.body)})
.then(r=>r.json().then(j=>({r,j}),()=>({r,j:{}}))).then(({r,j})=>{const a=(j.answers||[])[0];
if(a&&a.answer!=null)got.push(String(a.answer));else errs.push(String((a&&a.error)||j.error||('HTTP '+r.status)).slice(0,200))},
e=>errs.push(String((e&&e.message)||e).slice(0,200))).then(()=>{back++;settle(back===o.votes)})})`

/** The decide door, called from a child process so the synchronous pack code can hold it to a budget. */
export function hswarmDecide(q: LeadQuestion, budgetMs: number): Decision {
  const model = process.env.AGENTHYDRA_LEAD_MODEL || DEFAULT_MODEL
  if (model === 'off') return { answer: null, error: 'AGENTHYDRA_LEAD_MODEL=off' }
  const body = {
    items: [
      {
        id: 'lead',
        state: { message: q.message },
        question: q.question,
        type: 'choice',
        options: q.options,
      },
    ],
    // Jev answers nothing here, so everything goes to the fallback model at once.
    escalate_below: 1.01,
    fallback_model: model,
  }
  const input = JSON.stringify({
    url: process.env.AGENTHYDRA_DECIDE_URL || DECIDE_URL,
    tokenFile:
      process.env.AGENTHYDRA_HSWARM_TOKEN_FILE || join(homedir(), '.hswarm', 'console-token'),
    ms: Math.max(100, budgetMs - 150),
    votes: votesFor(budgetMs),
    body,
  })
  const r = spawnSync(process.execPath, ['-e', CHILD], {
    input,
    timeout: budgetMs,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.error || r.status !== 0)
    return { answer: null, error: r.error ? `${r.error.message}` : `exit ${r.status}` }
  try {
    return JSON.parse(r.stdout) as Decision
  } catch {
    return { answer: null, error: 'no answer' }
  }
}

const CACHE_MAX = 100
/** Picks the model made, so a launch that builds its slot twice asks once; a failed call is asked again. */
const cache = new Map<string, LeadPick>()

const noModel: Decider = () => ({ answer: null, error: 'no model call under test' })
const defaultDecider = (): Decider => (process.env.NODE_ENV === 'test' ? noModel : hswarmDecide)
let decider: Decider = defaultDecider()

/** Tests set a mock; null puts the default back (no model call under test, so no test reaches the network). */
export function setDecider(d: Decider | null): void {
  decider = d ?? defaultDecider()
  cache.clear()
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

export function leadQuestion(managers: CatalogEntry[], message: string): LeadQuestion {
  const coord = coordinatorOf(managers)
  const options: Record<string, string> = {
    none: 'No manager needed: a chore, a quick fact or status, a one-line edit, or a "keep going" / "ok" / "thanks".',
  }
  for (const m of managers)
    options[slugOf(m)] =
      `${m.name}${m.title ? ` (${m.title})` : ''}: ${m.when}${m === coord ? ' A message spanning several fields is theirs.' : ''}`
  return {
    message,
    question: `Which manager should lead the work this owner message asks for? A chore, a quick fact or status, a one-line edit or a "keep going" needs no manager: answer none for those, even where a manager's line covers quick asks. Research, a bug or a question inside one field is that field's manager's.${
      coord ? ` A message spanning several fields is ${coord.name}'s.` : ''
    }`,
    options,
  }
}

/** The word ranker: content words only, no `how` text, nothing under LEAD_MIN, and score before tier. Three or
 *  more managers hit means work across fields, so the coordinator. */
export function wordLead(entries: CatalogEntry[], message: string): CatalogEntry | null {
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
  })
  return ranked[0]?.entry ?? null
}

/**
 * The lead for a message: the model's pick among the managers or none, else the word ranker's. A message with no
 * content word ("keep going", "ok") needs no call. `log` appends which path chose.
 */
export function pickLead(
  entries: CatalogEntry[],
  message: string,
  budgetMs: number,
  opts: { cache?: boolean; log?: { dir: string; chat: string; at?: Date } } = {},
): LeadPick {
  const key = `${budgetMs}\n${message}`
  const hit = opts.cache === false ? undefined : cache.get(key)
  if (hit) return hit
  const started = performance.now()
  const managers = managersOf(entries)
  let pick: LeadPick
  if (!contentWords(message).length || !managers.length) pick = { id: null, path: 'words', ms: 0 }
  else {
    const d = decider(leadQuestion(managers, message), budgetMs)
    const ms = Math.round(performance.now() - started)
    const answer = d.answer?.trim().toLowerCase()
    const chosen = managers.find((m) => slugOf(m) === answer)
    if (answer === 'none') pick = { id: null, path: 'model', ms }
    else if (chosen) pick = { id: chosen.id, path: 'model', ms }
    else
      pick = {
        id: wordLead(entries, message)?.id ?? null,
        path: 'words',
        ms,
        error: d.error ?? `not an option: ${d.answer}`,
      }
  }
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
      },
      opts.log.at,
    )
  return pick
}

/** Owner messages that only keep the work going. */
const CONTINUE =
  /^(ok(ay)?|yes|yep|sure|go( on| ahead)?|continue|keep going|do it|thanks?|thank you|sounds good|next|proceed)\b/i

/** An owner message worth checking the lead against: three content words or more, not a continuation. */
export function substantive(message: string): boolean {
  const m = message.trim()
  return contentWords(m).length >= 3 && !(CONTINUE.test(m) && contentWords(m).length < 5)
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

export function leadNote(from: CatalogEntry | null, to: CatalogEntry, chat: string): string {
  return [
    `Lead change: this message is ${to.name}'s field${to.title ? ` (${to.title})` : ''}${
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

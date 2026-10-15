// The instance manager's judgment (shared/instance-manager.ts says what it is for). Pure: the engine (engine.ts)
// reads AgentHydra, hands what it read here, and carries out what comes back. Four questions live here and nowhere
// else: did an app go down with chats open in it (detect), why (causeOf, from its own log and its account), which of
// those chats it cut off mid-work (cutOff, from AgentHydra's gate), and which same-kind account should take them
// (rankTargets).

import type { DownCause, ManagedKind } from '@shared/instance-manager'

/** One app as AgentHydra reports it this look. */
export interface SeenInstance {
  ref: string
  kind: ManagedKind
  num: number
  name: string
  /** The Claude profile folder, or the Codex instance id: what the open and move calls take. */
  handle: string
  email: string | null
  plan: string | null
  running: boolean
  signedIn: boolean
  /** Why no chat can work in it though it may run signed in: its log says its account stopped working and nothing has
   *  run since (deadFromLog), or its plan reads Free, which Claude Code does not run on. null when neither. */
  dead: string | null
}

/** A chat open in an app now: a Claude chat with a live engine, or a Codex chat mid-turn. */
export interface OpenChat {
  id: string
  title: string
  ref: string
  /** Seen working (it wrote within Desk's working window, or a Codex turn is open). A Claude chat inside one long tool
   *  call writes nothing for minutes, so not busy says nothing yet: the gate judges it once its app goes down. */
  busy: boolean
  /** When its engine started, ms (the gate leaves out background jobs an earlier engine launched); null when unknown. */
  startedAt: number | null
}

/** What the manager remembers of one chat between looks. */
export interface RememberedChat {
  title: string
  busy: boolean
  startedAt: number | null
}

/** What the manager remembers of one app between looks. */
export interface Remembered {
  up: boolean
  lastUpAt: number | null
  /** The account's address while it was up: a signed-out app reads none, and its own account must still be told apart. */
  email?: string | null
  /** The chats open in it at the last look it was up, by id. */
  chats: Record<string, RememberedChat>
  seenAt: number
}

export type Memory = Record<string, Remembered>

/** An app that was up at the last look and is down now, with the chats it had open. */
export interface Down {
  instance: SeenInstance
  lastUpAt: number
  chats: OpenChat[]
  /** Down because it closed (false: still running, but signed out or its account dead). */
  closed: boolean
}

/** A memory older than this says nothing about now: Desk was not running, so the moment an app went down is not
 *  known, and neither is what it was doing. Such an app only starts being remembered again. */
export const STALE_MEMORY_MS = 10 * 60_000

/** An app AgentHydra has not listed for this long was removed: what was known of it is dropped, not carried forever. */
export const FORGET_MS = 24 * 60 * 60_000

/** Up: running, signed in, and its account still works. */
export const isUp = (i: SeenInstance): boolean => i.running && i.signedIn && i.dead === null

/**
 * Compares this look with the last one. Every app that was up and is not now, with chats open in it at the last look,
 * is a Down. The memory comes back updated: an app that is up remembers what is open in it now; one that is down keeps
 * what it had open when it went (so a look that fails to act can find it again).
 */
export function detect(
  memory: Memory,
  seen: readonly SeenInstance[],
  open: readonly OpenChat[],
  now: number,
): { memory: Memory; down: Down[] } {
  // An app AgentHydra did not list this time keeps what was known of it: a read that drops a row says nothing new.
  // One unlisted for FORGET_MS was removed, and is forgotten rather than saved again after every look.
  const next: Memory = Object.fromEntries(Object.entries(memory).filter(([, m]) => now - m.seenAt <= FORGET_MS))
  const down: Down[] = []
  for (const inst of seen) {
    const before = memory[inst.ref]
    const fresh = before !== undefined && now - before.seenAt <= STALE_MEMORY_MS
    const email = inst.email ?? before?.email ?? null
    if (isUp(inst)) {
      const mine = open.filter((c) => c.ref === inst.ref)
      const chats = Object.fromEntries(mine.map((c) => [c.id, { title: c.title, busy: c.busy, startedAt: c.startedAt }]))
      next[inst.ref] = { up: true, lastUpAt: now, email, chats, seenAt: now }
      continue
    }
    // A memory saved before chats were remembered this way has none: that app's chats are simply not known.
    const kept = before?.chats ?? {}
    next[inst.ref] = { up: false, lastUpAt: before?.lastUpAt ?? null, email, chats: kept, seenAt: now }
    if (!fresh || !before.up) continue
    const chats = Object.entries(kept).map(([id, c]) => ({ id, title: c.title, ref: inst.ref, busy: c.busy, startedAt: c.startedAt }))
    if (chats.length) down.push({ instance: { ...inst, email }, lastUpAt: before.lastUpAt ?? before.seenAt, chats, closed: !inst.running })
  }
  return { memory: next, down }
}

/** Claude Desktop's log lines: "2026-10-15 03:22:20 [info] beforeQuit: handler is ready for quit, so quitting". */
const LOG_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\b/
const QUIT = /\b(beforeQuit|willQuit|before-quit|will-quit)\b/
// Only the lines a real sign-out writes (read from 12 profiles' logs, 2026-10-15). Claude Desktop also writes "User is
// logged out, skipping account ID wait" at every start before the account loads, and "invalid_grant" on a routine token
// refresh it recovers from; either would turn a person's clean quit into a sign-out.
const LOGGED_OUT =
  /(Login-state transition \(loggedOut: false\b|\bAccount logged out\b|synthesizing logged-out|\bOAuth token (has been |was )?revoked\b)/i
/** Signed in again after it: an earlier sign-out line no longer says anything. */
const LOGGED_IN = /Login-state transition \(loggedOut: true\b/i
// A disabled organization writes "Your organization has disabled Claude subscription access for Claude Code" on every
// chat's turn (two profiles' logs, 2026-09-24 and 2026-10-14) while the app stays open, signed in, for minutes to hours.
const ACCOUNT_DEAD =
  /\b(organization (has been |has |is |was )?(disabled|suspended|deactivated)|account (has been |is |was )?(disabled|suspended|banned|deactivated)|subscription (has |is )?(expired|ended|lapsed|cancell?ed)|plan (has |is )?(expired|ended)|payment (failed|required)|billing (issue|problem))\b/i
/** A chat's failed turn that says its account is dead, as both logs above write it ("Session local_x query error: ...",
 *  "[CCD CycleHealth] local_x api_error (success): ..."). Narrower than ACCOUNT_DEAD on purpose: every look reads a
 *  running app's log with it, and a match takes that app's chats off it with their engines stopped. */
const ACCOUNT_DEAD_NOW = /\b(query error|api_error)\b.*\b(organization|account) (has been |has |is |was )?(disabled|suspended|banned|deactivated)\b/i
/** A chat's turn that ran to its end: with the account dead, none does (in both logs above, none between the errors). */
const TURN_DONE = /\[Stop hook\] Query completed for session\b/
// The app's own sign-in, as it writes it while it runs. It signs itself out with "[account] Navigated to /logout,
// synthesizing logged-out" (a first start on a newer Claude often does: 17 of 64 such lines in the fleet's logs,
// 2026-10-15). Narrower than LOGGED_OUT on purpose: a chat's "OAuth token revoked" error is not one, the app authorizes
// again by itself and its chats run on (one profile, 219 turns, 2026-10-09).
const APP_SIGNED_OUT = /\[account\] Navigated to \/logout|synthesizing logged-out|Login-state transition \(loggedOut: false\b/i
/** Signed in again, or a start with its account loaded: an earlier sign-out line no longer says anything. */
const APP_SIGNED_IN = /Login-state transition \(loggedOut: true\b|claude\.ai account active and logged in\b/i

/** A log line's own time, read as this PC's local time (the app writes local time), ms; null when it has none. */
export function lineTime(line: string): number | null {
  const m = LOG_LINE.exec(line)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/**
 * Why an app went down, from the tail of its log: the lines written from a minute before it was last seen up.
 * A sign-out or a dead account in those lines wins; then a clean quit; a log that stops without either is a crash.
 * null when there is no log to read (the caller says unknown).
 */
export function causeFromLog(log: string | null, since: number): { cause: DownCause; detail: string } | null {
  if (log === null) return null
  const from = since - 60_000
  const lines = log.split(/\r?\n/).filter((l) => {
    const t = lineTime(l)
    return t !== null && t >= from
  })
  const dead = lines.findLast((l) => ACCOUNT_DEAD.test(l))
  if (dead) return { cause: 'account-dead', detail: `its log: ${clip(dead)}` }
  const outAt = lines.findLastIndex((l) => LOGGED_OUT.test(l))
  if (outAt >= 0 && outAt > lines.findLastIndex((l) => LOGGED_IN.test(l)))
    return { cause: 'logged-out', detail: `its log: ${clip(lines[outAt] as string)}` }
  const quit = lines.findLast((l) => QUIT.test(l))
  if (quit) return { cause: 'quit', detail: `it quit cleanly (${clip(quit)})` }
  return { cause: 'crashed', detail: lines.length ? 'its log stops without a quit' : 'its log has nothing since it was last seen up' }
}

/**
 * Whether the app's account stopped working with the app still open: its log's last account-dead line comes after the
 * last turn that ran to its end and after the last sign-in. null when it did not (or there is no log).
 */
export function deadFromLog(log: string | null): string | null {
  if (log === null) return null
  const lines = log.split(/\r?\n/)
  const dead = lines.findLastIndex((l) => LOG_LINE.test(l) && ACCOUNT_DEAD_NOW.test(l))
  if (dead < 0) return null
  const since = Math.max(
    lines.findLastIndex((l) => TURN_DONE.test(l)),
    lines.findLastIndex((l) => LOGGED_IN.test(l)),
  )
  return dead > since ? `its log: ${clip(lines[dead] as string)}` : null
}

/**
 * Whether a running app has signed itself out: its log's last sign-out line comes after its last sign-in. AgentHydra's
 * own sign-in reads the stored login, which outlives this, so such an app looked up and could be given chats it cannot
 * run. Replayed over every profile's logs (2026-10-15): no chat turn of 12,541 ran to its end while this read signed
 * out. null when it has not (or there is no log).
 */
export function signedOutFromLog(log: string | null): string | null {
  if (log === null) return null
  const lines = log.split(/\r?\n/)
  const out = lines.findLastIndex((l) => LOG_LINE.test(l) && APP_SIGNED_OUT.test(l))
  if (out < 0 || out < lines.findLastIndex((l) => APP_SIGNED_IN.test(l))) return null
  return `its log: ${clip(lines[out] as string)}`
}

/** A Free plan: Claude Code does not run on one, so no chat can work in such an app or be moved into it. */
export const isFreePlan = (plan: string | null): boolean => /^\s*free\b/i.test(plan ?? '')

/** What the account says now, as AgentHydra resolves it over the network. */
export interface AccountProbe {
  status: string // live | cache | offline | loggedout | unknown (AgentHydra's CMAccountStatus)
  plan: string | null
}

/**
 * The cause, from everything known: the app's sign-in (still running but signed out), the account probe, the app's
 * own account-dead mark, then its log. A sign-out the app or the account shows beats what the log says; a plan that
 * turned free beats a clean quit.
 */
export function causeOf(
  d: Pick<Down, 'closed' | 'lastUpAt'> & { instance: Pick<SeenInstance, 'signedIn' | 'plan' | 'kind' | 'dead'> },
  probe: AccountProbe | null,
  log: string | null,
): { cause: DownCause; detail: string } {
  if (!d.instance.signedIn) return { cause: 'logged-out', detail: 'its account is no longer signed in' }
  if (probe?.status === 'loggedout') return { cause: 'logged-out', detail: 'AgentHydra reads its account as signed out' }
  if (d.instance.dead) return { cause: 'account-dead', detail: d.instance.dead }
  if (probe && /\bfree\b/i.test(probe.plan ?? '') && !/\bfree\b/i.test(d.instance.plan ?? 'free'))
    return { cause: 'account-dead', detail: `its plan is ${probe.plan} now (it was ${d.instance.plan})` }
  const fromLog = causeFromLog(log, d.lastUpAt)
  if (fromLog) return fromLog
  return { cause: 'unknown', detail: d.instance.kind === 'codex' ? 'the Codex app closed; it keeps no log to say why' : 'its log could not be read' }
}

/** The causes the manager acts on. A clean quit is a person's (or an update's, which brings the app straight back); an
 *  unknown cause may be one too, so it is left alone. A Codex app keeps no log: only its account (signed out, or a plan
 *  turned free) says it went down for a reason the manager acts on. */
export function acts(cause: DownCause): boolean {
  return cause !== 'quit' && cause !== 'unknown'
}

function clip(line: string): string {
  const t = line.replace(LOG_LINE, '').replace(/^\s*\[\w+\]\s*/, '').trim()
  return t.length > 140 ? `${t.slice(0, 139)}…` : t
}

/** AgentHydra's gate on one chat (orchestrator gate_chat.py --json --background), as the manager reads it. */
export interface TurnState {
  /** running (a live engine) | crashed (it stopped mid-turn or on an error) | finished (its turn ended) | ... */
  state: string
  /** crashed: mid-turn, usage-limit, overload, refused or error. */
  kind: string | null
  /** running: its turn has ended and it sits idle. */
  idle: boolean
  /** finished: the gate's lane; 'human' when a person interrupted it. */
  lane: string | null
  /** Seconds since its transcript was last written. */
  quietSecs: number | null
  /** Background jobs it launched (since its last engine started) that never reported back; null when its transcript
   *  could not be scanned for them. */
  outstanding: number | null
  cause: string
}

/** An error that ended a turn this close before the app was last seen up came with its going down. */
export const ERROR_WITH_DOWN_MS = 2 * 60_000

/**
 * Whether the app's going down cut this chat off mid-work, so it is moved and started again. The gate says: an engine
 * still alive mid-turn, one that died mid-turn (a tool call whose result never landed, an unanswered message), a turn
 * that ended on an error as the app went down, or a finished turn still waiting on background jobs it launched. A
 * turn that ran to its end, or that a person stopped, lost nothing. A chat seen working at the last look is moved
 * unless its turn ended on a recap that claims its work done: a transcript cannot tell a finished turn from one cut
 * between a text block and the tool call after it, and a chat started again for nothing costs one short turn while
 * one left behind loses its work. null when there is no verdict to read.
 */
export function cutOff(busy: boolean, t: TurnState | null, lastUpAt: number, now: number): { cut: boolean; why: string } | null {
  if (busy)
    return t?.state === 'finished' && t.lane === 'archive-candidate' && t.outstanding === 0
      ? { cut: false, why: 'its turn had ended with its work done' }
      : { cut: true, why: 'was working when the app went down' }
  if (!t) return null
  if (t.state === 'running')
    return t.idle ? { cut: false, why: 'its turn had ended' } : { cut: true, why: 'its engine was mid-turn' }
  if (t.state === 'crashed') {
    if (t.kind === 'mid-turn') return { cut: true, why: `it died mid-turn (${t.cause})` }
    const wroteAt = t.quietSecs === null ? null : now - t.quietSecs * 1000
    if (wroteAt !== null && wroteAt >= lastUpAt - ERROR_WITH_DOWN_MS) return { cut: true, why: `its turn ended on an error as the app went down (${t.cause})` }
    return { cut: false, why: `it had already stopped before (${t.cause})` }
  }
  if (t.state === 'finished') {
    if (t.lane === 'human') return { cut: false, why: 'a person had stopped it' }
    if (t.outstanding === null) return null
    if (t.outstanding > 0)
      return { cut: true, why: `it was waiting on ${t.outstanding} background job${t.outstanding === 1 ? '' : 's'} it launched` }
    return { cut: false, why: 'its turn had ended' }
  }
  return { cut: false, why: t.cause || t.state }
}

/** A same-kind account that could take the chats, with its usage. */
export interface Candidate {
  instance: SeenInstance
  fiveHourPct: number | null
  weeklyPct: number | null
  /** The fleet's line (85) or the account's own lower one. */
  capPct: number
  /** The usage reading is real (AgentHydra's severity is not 'unknown'). */
  known: boolean
}

export interface Ranked {
  instance: SeenInstance
  tierX: number
  usedPct: number
  /** tierX x the room left on its tighter window: how much work it can still take, in Pro-sized windows. */
  room: number
}

/**
 * How much one percent of this plan is worth. Claude: Max 20x = 20, Max 5x = 5, Team = 2, Pro or unknown = 1.
 * Codex: Pro = 10, Pro Lite = 3, Team or Business = 2, Plus or unknown = 1. Only the digits of "Max N" are read, as the
 * '×' can arrive mojibaked.
 */
export function tierOf(kind: ManagedKind, plan: string | null): number {
  const p = (plan ?? '').toLowerCase()
  if (kind === 'desktop') {
    const m = /max\D*(\d+)/.exec(p)
    if (m) return Number(m[1])
    return /team|enterprise/.test(p) ? 2 : 1
  }
  if (/pro\s*lite|prolite/.test(p)) return 3
  if (/\bpro\b/.test(p)) return 10
  return /team|business|enterprise/.test(p) ? 2 : 1
}

/**
 * The same-kind accounts that may take the chats, best first. Never the app that went down, nor another app signed
 * into the same account (it is down with it). A reading of 'unknown' is not room; nor is a window at or past the
 * account's line. Best is the most room (tier x what is left of its tighter window: the highest plan with the most
 * left this week and this five hours); a running app wins a tie, so nothing is opened that need not be.
 */
export function rankTargets(down: SeenInstance, candidates: readonly Candidate[]): Ranked[] {
  const email = down.email?.toLowerCase() ?? null
  const ranked: Ranked[] = []
  for (const c of candidates) {
    const i = c.instance
    if (i.kind !== down.kind || i.ref === down.ref || !i.signedIn || i.dead !== null) continue
    if (email !== null && i.email?.toLowerCase() === email) continue
    if (!c.known) continue
    const windows = [c.fiveHourPct, c.weeklyPct].filter((p): p is number => typeof p === 'number')
    if (!windows.length) continue
    const usedPct = Math.max(...windows)
    if (usedPct >= c.capPct) continue
    const tierX = tierOf(i.kind, i.plan)
    ranked.push({ instance: i, tierX, usedPct, room: Math.round(tierX * (c.capPct - usedPct) * 10) / 10 })
  }
  return ranked.sort((a, b) => b.room - a.room || Number(b.instance.running) - Number(a.instance.running) || a.instance.num - b.instance.num)
}

/** The text a moved chat is started again with. */
export function resumeText(from: string, to: string, cause: DownCause, causeDetail: string, sender: string): string {
  const why =
    cause === 'logged-out'
      ? 'its account was signed out'
      : cause === 'account-dead'
        ? 'its account stopped working'
        : cause === 'crashed'
          ? 'the app crashed'
          : 'the app closed'
  return [
    `[${sender}] Not from the user.`,
    `Your app (${from}) went down while you were working: ${why} (${causeDetail}).`,
    `You were moved to ${to} and this message starts you again.`,
    'Any tool call or background job that was running when the app went down was lost: check its result again before relying on it.',
    'Carry on with your task from where you left off.',
  ].join(' ')
}

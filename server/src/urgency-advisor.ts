// server/src/urgency-advisor.ts - the Urgency Advisor: a local loop (never a cloud routine) that finds every Desk 2 chat and
// Hydra Core seat whose current turn has run 30+ minutes and is still working, and delivers one nudge into it. See
// docs/URGENCY-ADVISOR.md. No model call: the name and the nudge lines come from the persona folder
// (people/manager/duke-urgency-advisor/persona.json); the repo holds only a neutral fallback.
//
// DELIVERY: POST /api/chats/:id/messages on Desk 2. For an SDK chat that pushes the message into the chat's open input
// stream, which the CLI takes at its next tool boundary: the turn is never stopped or relaunched.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import { getSetting, setSetting } from './db'
import { type DeskChat, deskChats, deskPost } from './desk-client'
import { managerFile } from './manager-folders'

export const PERSONA_SLUG = 'duke-urgency-advisor'
export const FALLBACK_NAME = 'Urgency Advisor'
export const FALLBACK_LINE =
  'This turn on "{title}" has run {minutes} minutes. In the first line of your next reply, say what is left and when it will be done, then finish faster without cutting corners.'
/** A turn this old is nudged, and no chat is nudged again before another one of these has passed. */
export const NUDGE_EVERY_MS = 30 * 60_000

export interface AdvisorSettings {
  enabled: boolean
  intervalMinutes: number
}

const KEY_ON = 'urgency_advisor_enabled'
const KEY_MIN = 'urgency_advisor_minutes'

/** Default ON, every 30 minutes; only an explicit '0' turns it off. */
export function getAdvisorSettings(): AdvisorSettings {
  const raw = getSetting(KEY_MIN).trim()
  const n = raw ? Number(raw) : 30
  return {
    enabled: getSetting(KEY_ON) !== '0',
    intervalMinutes: Number.isFinite(n) ? Math.min(720, Math.max(5, Math.round(n))) : 30,
  }
}

export function setAdvisorSettings(patch: Partial<AdvisorSettings>): AdvisorSettings {
  if (typeof patch.enabled === 'boolean') setSetting(KEY_ON, patch.enabled ? '1' : '0')
  if (typeof patch.intervalMinutes === 'number' && Number.isFinite(patch.intervalMinutes))
    setSetting(KEY_MIN, String(Math.min(720, Math.max(5, Math.round(patch.intervalMinutes)))))
  return getAdvisorSettings()
}

export interface Persona {
  name: string
  lines: string[]
}

/** The persona's name and nudge lines, or the neutral fallback when the file is missing or unreadable. */
export function readPersona(): Persona {
  try {
    const file = managerFile(PERSONA_SLUG, 'persona.json')
    if (file) {
      const p = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; lines?: unknown }
      const lines = Array.isArray(p.lines)
        ? p.lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '')
        : []
      const name =
        typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : FALLBACK_NAME
      return { name: name.replace(/[\]\n]/g, ' '), lines: lines.length ? lines : [FALLBACK_LINE] }
    }
  } catch {}
  return { name: FALLBACK_NAME, lines: [FALLBACK_LINE] }
}

/** The contract text: the header line, a blank line, the nudge. */
export function nudgeText(name: string, line: string, minutes: number, title: string): string {
  const body = line.replaceAll('{minutes}', String(minutes)).replaceAll('{title}', title)
  return `[Urgency Advisor · ${name}] Sent on the owner's behalf.\n\n${body}`
}

/** The chat fields the advisor reads (Desk 2's ChatSummary). */
export type AdvisorChat = DeskChat & {
  turnStartedAt?: number | null
  workerId?: string | null
  manager?: { role?: string } | null
}

/** A seat or lead of Hydra Core, or any Desk chat that is not a CliMayte drone worker. */
function watched(c: AdvisorChat): boolean {
  if (c.manager?.role === 'seat' || c.manager?.role === 'lead') return true
  return c.workerId === undefined
}

/** chat id -> the turn start and the moment of the last nudge in that turn. */
export type Memory = Record<string, { turnStartedAt: number; lastNudgeAt: number }>

export interface AdvisorDeps {
  now: () => number
  settings: () => AdvisorSettings
  chats: () => Promise<AdvisorChat[]>
  send: (chatId: string, text: string) => Promise<void>
  persona: () => Persona
  load: () => Memory
  save: (m: Memory) => void
  log: (line: string) => void
}

/** One pass: nudges each working chat past 30 minutes that was not nudged in the last 30. Returns the chat ids nudged. */
export async function advisorPass(d: AdvisorDeps): Promise<string[]> {
  if (!d.settings().enabled) return []
  const now = d.now()
  let chats: AdvisorChat[]
  try {
    chats = await d.chats()
  } catch {
    return []
  }
  const mem = d.load()
  const persona = d.persona()
  const sent: string[] = []
  let count = Object.keys(mem).length
  for (const c of chats) {
    if (c.status !== 'working' || !watched(c)) continue
    const started = c.turnStartedAt
    if (typeof started !== 'number' || now - started < NUDGE_EVERY_MS) continue
    const last = mem[c.id]
    if (last && last.turnStartedAt === started && now - last.lastNudgeAt < NUDGE_EVERY_MS) continue
    const minutes = Math.floor((now - started) / 60_000)
    const line = persona.lines[count++ % persona.lines.length] ?? FALLBACK_LINE
    let ok = true
    try {
      await d.send(c.id, nudgeText(persona.name, line, minutes, c.title ?? 'this chat'))
    } catch {
      ok = false
    }
    d.log(`[urgency-advisor] chat=${c.id} minutes=${minutes} sent=${ok ? 'ok' : 'failed'}`)
    if (ok) {
      mem[c.id] = { turnStartedAt: started, lastNudgeAt: now }
      sent.push(c.id)
    }
  }
  // Forget chats that are no longer listed.
  const live = new Set(chats.map((c) => c.id))
  for (const id of Object.keys(mem)) if (!live.has(id)) delete mem[id]
  d.save(mem)
  return sent
}

const stateFile = () => join(DATA_DIR, 'urgency-advisor.json')

function realDeps(): AdvisorDeps {
  return {
    now: Date.now,
    settings: getAdvisorSettings,
    chats: async () => (await deskChats()) as AdvisorChat[],
    send: async (id, text) => {
      await deskPost(`/api/chats/${encodeURIComponent(id)}/messages`, { text })
    },
    persona: readPersona,
    load: () => {
      try {
        return JSON.parse(readFileSync(stateFile(), 'utf8')) as Memory
      } catch {
        return {}
      }
    },
    save: (m) => {
      try {
        writeFileSync(stateFile(), JSON.stringify(m))
      } catch (err) {
        console.warn('[urgency-advisor] could not save its memory:', err)
      }
    },
    log: (line) => console.log(line),
  }
}

let timer: ReturnType<typeof setInterval> | undefined
let lastRunAt = 0

/** Starts the loop: a check each minute runs a pass when the interval has passed (so a changed setting applies at once). */
export function startUrgencyAdvisor(): void {
  if (timer) return
  const deps = realDeps()
  timer = setInterval(() => {
    const s = getAdvisorSettings()
    if (!s.enabled || Date.now() - lastRunAt < s.intervalMinutes * 60_000) return
    lastRunAt = Date.now()
    advisorPass(deps).catch((err) => console.warn('[urgency-advisor] pass failed:', err))
  }, 60_000)
  timer.unref()
}

export function stopUrgencyAdvisor(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

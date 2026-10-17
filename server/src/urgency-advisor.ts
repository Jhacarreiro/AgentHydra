// server/src/urgency-advisor.ts - the Urgency Advisor: a local loop (never a cloud routine) that visits every Desk 2 chat and
// Hydra Core seat that has been busy for 30+ minutes, again every interval, and talks to it as the persona (Duke). See
// docs/URGENCY-ADVISOR.md. The persona (name, brief.md, fallback `lines`) is read at runtime from
// people/manager/duke-urgency-advisor/; the repo holds only a neutral fallback. One short model call per message, on
// Desk 2's private route for chat text (desk2 POST /api/advisor/compose); a failed call falls back to a `lines` template.
//
// DELIVERY: POST /api/chats/:id/messages on Desk 2, exactly how the owner's own message goes (manager.send with now: true;
// never the ping route, send-now or interrupt). A plain Desk chat takes it on the open input stream at the CLI's next tool
// boundary; a worker-backed chat has its turn stopped cleanly and the session continues with the message first.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { climayteGet } from './climayte-view'
import { DATA_DIR } from './config'
import { canonicalConfigDir, getCliInstance } from './core/cli-instances'
import { getSetting, setSetting } from './db'
import { type DeskChat, deskChats, deskPost, transcriptItems } from './desk-client'
import { managerFile } from './manager-folders'

export const PERSONA_SLUG = 'duke-urgency-advisor'
export const FALLBACK_NAME = 'Urgency Advisor'
export const FALLBACK_LINE =
  'This chat, "{title}", has been busy for {minutes} minutes. In the first line of your next reply, say what is left and when it will be done, then finish faster without cutting corners.'
/** A chat busy this long is visited. */
export const STREAK_MS = 30 * 60_000
/** A chat that sat idle longer than this starts a new busy streak. */
export const IDLE_GAP_MS = 5 * 60_000
/** How long Duke waits for the chat's answer to his message. */
export const ANSWER_WAIT_MS = 10 * 60_000
export const MAX_REPLIES = 2
export const TLDR_CHARS = 4000

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

/** The persona's name and fallback lines, or the neutral fallback when the file is missing or unreadable. */
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

/** The persona's brief.md, read at runtime; '' when it is missing. */
export function readBrief(): string {
  try {
    const file = managerFile(PERSONA_SLUG, 'brief.md')
    return file ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
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

/** Per chat: the start of its busy streak, the last time it was seen working, and its last visit. */
export type Memory = Record<
  string,
  { streakStart: number; lastBusyAt: number; lastVisitAt: number }
>

export interface AdvisorDeps {
  now: () => number
  settings: () => AdvisorSettings
  chats: () => Promise<AdvisorChat[]>
  /** Delivers the full contract text into the chat; throws when it did not land. */
  send: (chat: AdvisorChat, text: string) => Promise<void>
  persona: () => Persona
  brief: () => string
  /** The chat's TL;DR: title, the owner's last messages, the AI's last replies, capped. */
  tldr: (chat: AdvisorChat) => Promise<string>
  /** One short model call; null on failure. */
  compose: (chat: AdvisorChat, system: string, prompt: string) => Promise<string | null>
  /** Marks where the chat's replies stand, before a message is sent... */
  baseline: (chat: AdvisorChat) => Promise<number>
  /** ...then waits up to `ms` for the AI's next text after it; null when none came. */
  answer: (chat: AdvisorChat, baseline: number, ms: number) => Promise<string | null>
  load: () => Memory
  save: (m: Memory) => void
  log: (line: string) => void
}

const SYSTEM_RULES =
  "You write ONE short message that is sent into a working AI coding chat on the owner's behalf, in the persona's voice. " +
  'Plain text, no markdown, at most 90 words. Reply with the message only. If told to answer SKIP, answer exactly SKIP.'

async function words(
  d: AdvisorDeps,
  chat: AdvisorChat,
  brief: string,
  prompt: string,
): Promise<string | null> {
  try {
    return (await d.compose(chat, `${brief}\n\n${SYSTEM_RULES}`, prompt))?.trim() || null
  } catch {
    return null
  }
}

async function visit(
  d: AdvisorDeps,
  chat: AdvisorChat,
  minutes: number,
  nth: number,
): Promise<void> {
  const persona = d.persona()
  const brief = d.brief()
  const tldr = await d.tldr(chat).catch(() => `Title: ${chat.title ?? ''}`)
  const line = persona.lines[nth % persona.lines.length] ?? FALLBACK_LINE
  const fallback = line
    .replaceAll('{minutes}', String(minutes))
    .replaceAll('{title}', chat.title ?? 'this chat')
  const pushPrompt =
    `The chat below has been busy for ${minutes} minutes. Write your push: first show you understand what it is doing ("OK, I get it, you're doing ..."), ` +
    'then demand why it is not done yet, and end by telling it to answer you in its next text: what is left and when it will be done.\n\n' +
    `Chat summary:\n${tldr}`
  let message = (await words(d, chat, brief, pushPrompt)) ?? fallback
  for (let n = 0; n <= MAX_REPLIES; n++) {
    const base = await d.baseline(chat).catch(() => 0)
    let ok = true
    try {
      await d.send(
        chat,
        `[Urgency Advisor · ${persona.name}] Sent on the owner's behalf.\n\n${message}`,
      )
    } catch {
      ok = false
    }
    d.log(
      `[urgency-advisor] chat=${chat.id} minutes=${minutes} ${n === 0 ? 'push' : `reply=${n}`} sent=${ok ? 'ok' : 'failed'}`,
    )
    if (!ok || n === MAX_REPLIES) return
    const theirs = await d.answer(chat, base, ANSWER_WAIT_MS).catch(() => null)
    if (!theirs) return
    const replyPrompt =
      `Chat summary:\n${tldr}\n\nYour message:\n${message}\n\nThe chat's answer:\n${theirs.slice(0, 2000)}\n\n` +
      'If the answer is truly good (the work is finished, or it is blocked on the owner), answer exactly SKIP. ' +
      'Otherwise reply in your voice, pushing back on the reason ("That is not a good enough reason. You can do it faster. Make it a hundred times faster.").'
    const reply = await words(d, chat, brief, replyPrompt)
    if (!reply || /^\s*SKIP\b/i.test(reply)) return
    message = reply
  }
}

/** The advisor over its deps: pass() looks at every chat (cheap, run it every minute) and starts the visits that are due. */
export function createAdvisor(d: AdvisorDeps) {
  let mem: Memory | null = null
  const visiting = new Set<string>()
  return {
    /** One look. Resolves when the visits it started have ended; returns the chat ids visited. */
    async pass(): Promise<string[]> {
      const s = d.settings()
      if (!s.enabled) return []
      let chats: AdvisorChat[]
      try {
        chats = await d.chats()
      } catch {
        return []
      }
      mem ??= d.load()
      const m = mem
      const now = d.now()
      const gap = s.intervalMinutes * 60_000
      const due: [AdvisorChat, number][] = []
      for (const c of chats) {
        if (c.status !== 'working' || !watched(c)) continue
        const started = typeof c.turnStartedAt === 'number' ? c.turnStartedAt : now
        let r = m[c.id]
        // A turn that began more than 5 minutes after the chat was last seen working is a new streak; the owner's
        // messages, mid-turn or within 5 minutes of a turn's end, never are.
        if (!r || started > r.lastBusyAt + IDLE_GAP_MS)
          r = m[c.id] = { streakStart: started, lastBusyAt: now, lastVisitAt: r?.lastVisitAt ?? 0 }
        r.lastBusyAt = now
        if (now - r.streakStart >= STREAK_MS && now - r.lastVisitAt >= gap && !visiting.has(c.id)) {
          r.lastVisitAt = now
          due.push([c, Math.floor((now - r.streakStart) / 60_000)])
        }
      }
      const live = new Set(chats.map((c) => c.id))
      for (const id of Object.keys(m))
        if (!live.has(id) && now - (m[id]?.lastBusyAt ?? 0) > IDLE_GAP_MS) delete m[id]
      d.save(m)
      await Promise.all(
        due.map(async ([c, minutes]) => {
          visiting.add(c.id)
          try {
            await visit(d, c, minutes, Object.keys(m).indexOf(c.id))
          } catch (err) {
            d.log(
              `[urgency-advisor] chat=${c.id} visit failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          } finally {
            visiting.delete(c.id)
          }
        }),
      )
      return due.map(([c]) => c.id)
    },
  }
}

interface Item {
  kind?: string
  text?: string
  streaming?: boolean
}
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)

/** The chat's TL;DR from Desk's transcript: title, the owner's last 3 messages, the AI's last 3 replies, capped. */
export function buildTldr(title: string, items: Item[]): string {
  const say = (kind: string, n: number, per: number): string =>
    items
      .filter((i) => i.kind === kind && i.text?.trim())
      .slice(-n)
      .map((i) => `- ${clip((i.text ?? '').trim().replace(/\s+/g, ' '), per)}`)
      .join('\n')
  return clip(
    `Title: ${title}\nThe owner's last messages:\n${say('user', 3, 600)}\nThe AI's last replies:\n${say('assistant_text', 3, 800)}`,
    TLDR_CHARS,
  )
}

const stateFile = () => join(DATA_DIR, 'urgency-advisor.json')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The config folder of the account a CliMayte worker runs on now (null when the worker or its account is unknown). */
export function workerAccountDir(workerId: string): string | null {
  const accountId = climayteGet(workerId)?.accountId
  if (!accountId) return null
  const rec = getCliInstance(accountId)
  return rec ? canonicalConfigDir(rec) : null
}

export function composeBody(
  chat: AdvisorChat,
  system: string,
  prompt: string,
  accountDirOf: (workerId: string) => string | null = workerAccountDir,
): { chatId: string; system: string; prompt: string; configDir?: string } {
  const configDir = chat.workerId ? accountDirOf(chat.workerId) : null
  return configDir
    ? { chatId: chat.id, system, prompt, configDir }
    : { chatId: chat.id, system, prompt }
}

function realDeps(): AdvisorDeps {
  const replies = async (id: string): Promise<Item[]> =>
    ((await transcriptItems(id)) as Item[]).filter((i) => i.kind === 'assistant_text')
  return {
    now: Date.now,
    settings: getAdvisorSettings,
    chats: async () => (await deskChats()) as AdvisorChat[],
    send: async (chat, text) => {
      await deskPost(`/api/chats/${encodeURIComponent(chat.id)}/messages`, { text })
    },
    persona: readPersona,
    brief: readBrief,
    tldr: async (chat) => buildTldr(chat.title ?? '', (await transcriptItems(chat.id)) as Item[]),
    compose: async (chat, system, prompt) => {
      const r = await Promise.race([
        deskPost('/api/advisor/compose', composeBody(chat, system, prompt)),
        sleep(60_000).then(() => null),
      ])
      return typeof r?.text === 'string' ? r.text : null
    },
    baseline: async (chat) => (await replies(chat.id)).length,
    answer: async (chat, baseline, ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        await sleep(15_000)
        const now = await replies(chat.id).catch(() => [] as Item[])
        const fresh = now.slice(baseline).find((i) => !i.streaming && i.text?.trim())
        if (fresh) return fresh.text ?? null
      }
      return null
    },
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

/** Starts the loop: a look each minute (it measures busy streaks); each chat is visited once per interval. */
export function startUrgencyAdvisor(): void {
  if (timer) return
  const advisor = createAdvisor(realDeps())
  timer = setInterval(() => {
    advisor.pass().catch((err) => console.warn('[urgency-advisor] pass failed:', err))
  }, 60_000)
  timer.unref()
}

export function stopUrgencyAdvisor(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

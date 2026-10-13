// The session header's calls to AgentHydra, through Desk 2's own /ah/api (server/src/plugins/45-agenthydra.ts
// hands them to the one AgentHydra daemon). The same endpoints AgentHydra's Sessions tab calls.
import type { AhCodexInstance, AhCodexMovePlan, AhInstance, AhSecrets, AhSessionRow, AhUsage } from './logic'

const BASE = '/ah/api'

// An answer that is not JSON (a dev server's index page sent back for an address it does not know) is an error, apart
// from a JSON null, which some calls answer (instanceAccount): before, it came back as null and the instance list's .map
// threw outside any catch.
const NOT_JSON = Symbol('not JSON')

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init?.body ? { ...init, headers: { 'content-type': 'application/json' } } : init)
  const read = (await res.json().catch(() => NOT_JSON)) as (T & { error?: unknown }) | null | typeof NOT_JSON
  const body = read === NOT_JSON ? null : read
  if (!res.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `${res.status} ${res.statusText}`)
  if (read === NOT_JSON) throw new Error(`${res.status} ${res.statusText}: not a JSON answer`)
  return body as T
}

/** `?source=…&locator=…`: a locator names the exact store when two products can hold the same id. */
function where(row: Pick<AhSessionRow, 'source' | 'locator'>): string {
  return `?source=${encodeURIComponent(row.source)}${row.locator ? `&locator=${encodeURIComponent(row.locator)}` : ''}`
}
const sid = (row: Pick<AhSessionRow, 'session_id'>) => encodeURIComponent(row.session_id)

export const ah = {
  /** The session's row; no source finds the newest session with that id. */
  session: (id: string, source?: string) => call<AhSessionRow>(`/sessions/${encodeURIComponent(id)}${source ? `?source=${encodeURIComponent(source)}` : ''}`),
  usage: (row: AhSessionRow) => call<AhUsage>(`/sessions/${sid(row)}/usage${where(row)}`),
  secrets: (row: AhSessionRow) => call<AhSecrets>(`/sessions/${sid(row)}/secrets${where(row)}`),
  fileLocation: (row: AhSessionRow) => call<{ path: string }>(`/sessions/${sid(row)}/file-location${where(row)}`),
  /** Opens the transcript with the PC's own program for it. */
  openFile: (row: AhSessionRow) => call<{ ok: boolean }>(`/sessions/${sid(row)}/open-file${where(row)}`, { method: 'POST' }),
  /** Puts the file itself (not its text) on the PC's clipboard, which a page cannot do. */
  copyFile: (row: AhSessionRow) => call<{ ok: boolean; filename?: string; reason?: string }>(`/sessions/${sid(row)}/copy-file${where(row)}`, { method: 'POST' }),
  /** Opens a terminal on `claude --resume <id>`; the command comes back either way. */
  resumeInTerminal: (row: AhSessionRow) => call<{ ok: boolean; command: string; reason?: string }>(`/sessions/${sid(row)}/resume-terminal${where(row)}`, { method: 'POST' }),
  instances: () => call<AhInstance[]>('/instances'),
  /** The account an instance is signed into, from what is on disk (no sign-in request). */
  instanceAccount: (dir: string) => call<AhInstance['account']>(`/instances/${encodeURIComponent(dir)}/account?noNetwork=1`),
  focusInstance: (dir: string) => call<{ ok: boolean; message?: string }>(`/instances/${encodeURIComponent(dir)}/focus`, { method: 'POST' }),
  openInstance: (dir: string) => call<{ ok: boolean; message?: string }>(`/instances/${encodeURIComponent(dir)}/open`, { method: 'POST' }),
  /** Moves the chat to another account's desktop app; its current title restated is the required title decision. */
  migrate: (row: AhSessionRow, instanceRef: string) => land(row.session_id, instanceRef, { confirm_title: row.title }),
  /**
   * Archives the chat in its account's desktop app, through the app when it runs (`instanceRef`: that account; null lets
   * AgentHydra find the one account that has it). Never throws on a refusal: archiveVerdict reads the answer.
   */
  desktopArchive: async (sessionId: string, instanceRef: string | null): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/desktop-archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(instanceRef ? { instance_ref: instanceRef } : {})
    })
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { status: res.status, body: body && typeof body === 'object' ? body : null }
  },
  /** A whole copy of the chat under a new session id, titled "<title> (copy)", on no account yet (AgentHydra's session-branch). */
  copy: (row: AhSessionRow) =>
    call<{ session_id: string }>(`/sessions/${sid(row)}/branch${where(row)}`, { method: 'POST', body: JSON.stringify({ whole: true, title: row.title }) }),
  exportUrl: (row: AhSessionRow, format: 'markdown' | 'html') => `${BASE}/sessions/${sid(row)}/export${where(row)}&format=${format}`,
  fileUrl: (row: AhSessionRow) => `${BASE}/sessions/${sid(row)}/file${where(row)}`,
  codexInstances: () => call<AhCodexInstance[]>('/codex-instances'),
  /** Every active chat of one Codex account, as the move to `targetId` would take it; moves nothing. */
  codexMovePlan: (fromId: string, targetId: string) =>
    call<AhCodexMovePlan>(`/codex-instances/${encodeURIComponent(fromId)}/move-chats?targetId=${encodeURIComponent(targetId)}`),
  /** Copies one planned chat to the target account, checks it landed whole, then archives the original. */
  moveCodexChat: (fromId: string, body: { targetId: string; threadId: string; updatedAt: number; sourceAccountId: string | null; targetAccountId: string | null }) =>
    call<{ ok: boolean; error?: string }>(`/codex-instances/${encodeURIComponent(fromId)}/move-chat`, { method: 'POST', body: JSON.stringify(body) })
}

type Landing = { ok: boolean; error?: string; sourceStillShown?: string[] }

/** AgentHydra's migrate: lands the chat in the account's desktop app and retires its old copies; `title` is the required title decision. */
function land(sessionId: string, instanceRef: string, title: { confirm_title: string } | { title: string }): Promise<Landing> {
  return call<Landing>(`/sessions/${encodeURIComponent(sessionId)}/migrate`, { method: 'POST', body: JSON.stringify({ instance_ref: instanceRef, ...title }) })
}

/** Migrate by the session's id alone (the row menu's Move to account): AgentHydra's row first, whose title the move restates. */
export async function moveSession(sessionId: string, instanceRef: string): Promise<Landing> {
  return ah.migrate(await ah.session(sessionId, 'claude'), instanceRef)
}

/**
 * desktop-archive's answer as one verdict. Archived: `stillShown` when its app runs and still lists it until it restarts.
 * A chat no desktop account holds (a terminal session: AgentHydra found no record, 404) has nothing to take off: also
 * archived. Anything refused, unverified or put back right after the write is not.
 */
function archiveVerdict(status: number, body: Record<string, unknown> | null): { ok: true; stillShown: boolean } | { ok: false; error: string } {
  const said = [body?.error, body?.reason, body?.note].find((s): s is string => typeof s === 'string' && s !== '')
  if (status === 404 && Array.isArray(body?.hits) && body.hits.length === 0) return { ok: true, stillShown: false }
  if (status >= 400 || !body || body.ok === false) return { ok: false, error: said ?? `AgentHydra answered ${status}` }
  if (body.verified === false) return { ok: false, error: said ?? 'its app did not confirm the archive' }
  if (body.flagStuck === false && Array.isArray(body.flagOnDisk) && body.flagOnDisk.length > 0)
    return { ok: false, error: 'something put it back on its account right after the archive' }
  return { ok: true, stillShown: body.stillOnScreen === true }
}

/** Move to account > Unassigned: archives the chat on the account it is on, leaving it on none (the sidebar marks it). */
export async function unassignSession(sessionId: string, instanceRef: string | null): Promise<ReturnType<typeof archiveVerdict>> {
  const { status, body } = await ah.desktopArchive(sessionId, instanceRef)
  return archiveVerdict(status, body)
}

/**
 * Duplicate to account: AgentHydra copies the whole chat under a new id, then lands the copy on the account like a move
 * does. The original is not touched. A copy that could not land is on no account: `copyId` names it.
 */
export async function duplicateSession(sessionId: string, instanceRef: string): Promise<{ ok: boolean; error?: string; copyId?: string; title?: string }> {
  const row = await ah.session(sessionId, 'claude')
  const made = await ah.copy(row)
  const title = row.title?.trim() ? `${row.title.trim().slice(0, 200)} (copy)` : 'Copy'
  try {
    const x = await land(made.session_id, instanceRef, { title })
    return x.ok ? { ok: true, copyId: made.session_id, title } : { ok: false, error: x.error ?? 'AgentHydra did not say why', copyId: made.session_id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), copyId: made.session_id }
  }
}

/**
 * Move to account for a Codex chat (`codex:<instance id>`): a Codex thread cannot be re-homed, so AgentHydra copies it,
 * verifies the copy and archives the original (docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md). The move takes only a chat that
 * came back from a plan, with its updatedAt and both accounts, so the plan is read first, at the moment of the click:
 * a chat Codex does not list as active on its account is refused here rather than guessed at. Either account's Codex
 * app may be open: an open one archives the original itself (owner, 2026-10-13).
 */
export async function moveCodexSession(
  sessionId: string,
  instanceRef: string
): Promise<{ ok: boolean; error?: string; stoppedCommands?: string[] }> {
  const targetId = instanceRef.replace(/^codex:/, '')
  const from = (await ah.session(sessionId, 'codex')).instance_ref?.match(/^codex:(.+)$/)?.[1]
  if (!from) return { ok: false, error: 'AgentHydra does not know which Codex account this chat is on.' }
  if (from === targetId) return { ok: false, error: 'It is already on that account.' }
  const plan = await ah.codexMovePlan(from, targetId)
  const chat = plan.chats.find((c) => c.id === sessionId)
  if (!chat) return { ok: false, error: 'Codex does not list it as an active chat on its account.' }
  return ah.moveCodexChat(from, {
    targetId,
    threadId: chat.id,
    updatedAt: chat.updatedAt,
    sourceAccountId: plan.sourceAccountId,
    targetAccountId: plan.targetAccountId
  })
}

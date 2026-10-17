// Pure composer logic: slash command filtering, per-chat drafts, image validation and shrinking, labels.
// No Vue and no DOM here, so web/test/composer can test it with plain bun.

import { DEFAULT_EFFORT, DEFAULT_MODEL, MAX_PICTURE_SIDE } from '@shared/protocol'
import type { AccountInfo, AccountRef, ChatStatus, Effort, PermissionMode, SlashCommandInfo, TranscriptItem } from '@shared/protocol'
import { modelName } from '@/components/shell/logic'

// Slash commands

/** The command query when the box holds only a leading `/word` (no space yet), else null. */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text)
  return m ? m[1] : null
}

/** Commands matching `query`: name prefix first, then name substring, then description; case-insensitive. */
export function filterSlashCommands(commands: SlashCommandInfo[], query: string, limit = 50): SlashCommandInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...commands].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit)
  const ranked: { cmd: SlashCommandInfo; rank: number }[] = []
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase()
    let rank = -1
    if (name.startsWith(q)) rank = 0
    else if (name.includes(q)) rank = 1
    else if (cmd.description.toLowerCase().includes(q)) rank = 2
    if (rank >= 0) ranked.push({ cmd, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name))
  return ranked.slice(0, limit).map((r) => r.cmd)
}

/** The box text after picking a command: `/name ` ready for its arguments. */
export function applySlashCommand(cmd: SlashCommandInfo): string {
  return `/${cmd.name} `
}

// Drafts (localStorage, one per chat; 'new' for the new-session box)

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DRAFT_PREFIX = 'hydra-desk:draft:'

export function draftKey(chatId: string | null): string {
  return DRAFT_PREFIX + (chatId ?? 'new')
}

/**
 * Whose box the composer shows: the chat's own, or the new-session box of its folder ('new:<folder>'), so
 * each workspace's unsent message waits for it. Null is the new-session box before a folder is chosen.
 */
export function draftSlot(chatId: string | null, cwd: string | null): string | null {
  if (chatId) return chatId
  return cwd ? `new:${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}` : null
}

export function loadDraft(storage: DraftStorage | null, chatId: string | null): string {
  if (!storage) return ''
  try {
    return storage.getItem(draftKey(chatId)) ?? ''
  } catch {
    return ''
  }
}

/** Saves the draft; an empty or whitespace-only draft removes the key instead of keeping an empty one. */
export function saveDraft(storage: DraftStorage | null, chatId: string | null, text: string): void {
  if (!storage) return
  try {
    if (text.trim()) storage.setItem(draftKey(chatId), text)
    else storage.removeItem(draftKey(chatId))
  } catch {
    // Storage full or blocked: the draft only lives in memory, which is fine.
  }
}

// Images

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** null when the file can be attached, else the message to show. */
export function validateImage(file: { name: string; type: string; size: number }): string | null {
  const name = file.name || 'Pasted image'
  if (!IMAGE_TYPES.includes(file.type)) {
    return `${name} is not an image Claude can read (PNG, JPEG, GIF or WebP).`
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `${name} is ${formatBytes(file.size)}; images are limited to 5 MB each.`
  }
  return null
}

// Shrinking: shrink.ts draws; the sizes and the types are worked out here.

/** The quality a shrunk JPEG or WebP is encoded at. */
export const SHRINK_QUALITY = 0.92

/**
 * What a picture is shrunk to: its longest side MAX_PICTURE_SIDE, the other in proportion, in its own type (a GIF, of
 * which Claude reads one frame, as a PNG of its first). Null when it goes byte for byte as it is: within the side, or
 * not a PNG, JPEG, GIF or WebP.
 */
export function shrinkPlan(p: { width: number; height: number; type: string }, max = MAX_PICTURE_SIDE): { width: number; height: number; type: string } | null {
  const longest = Math.max(p.width, p.height)
  if (!IMAGE_TYPES.includes(p.type) || longest <= max) return null
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(p.width * scale)),
    height: Math.max(1, Math.round(p.height * scale)),
    type: p.type === 'image/gif' ? 'image/png' : p.type
  }
}

/** The type a shrunk picture is encoded again in when it is still over MAX_IMAGE_BYTES (a PNG as a JPEG); else null. */
export function shrinkFallback(type: string, bytes: number): string | null {
  return type === 'image/png' && bytes > MAX_IMAGE_BYTES ? 'image/jpeg' : null
}

/** A shrunk picture's name: a new type gets its extension ('shot.gif' as a PNG is 'shot.png'); a name it keeps stays. */
export function shrunkName(name: string, from: string, to: string): string {
  if (!name || from === to) return name
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.${to === 'image/jpeg' ? 'jpg' : to.slice('image/'.length)}`
}

/** Base64 payload of a data: URL (what ImageRef.dataBase64 carries). */
export function dataUrlToBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(',')
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl
}

// Files

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

/** null when any file can be attached, else the message to show. */
export function validateAttachment(file: { name: string; size: number }): string | null {
  const name = file.name || 'File'
  if (file.size === 0) return `${name} is empty.`
  if (file.size > MAX_ATTACHMENT_BYTES) return `${name} is ${formatBytes(file.size)}; files are limited to 100 MB each.`
  return null
}

/** The text a sent message carries for each attached file: the path the model opens with Read. */
export function withFileLines(text: string, paths: string[]): string {
  return [text.trim(), ...paths.map((p) => `[File: source: ${p}]`)].filter(Boolean).join('\n')
}

// Labels

/**
 * The permission-mode menu, in the real app's order, labels and descriptions (docs/reference/real
 * DESIGN.md "Menus"). The real "Auto" mode has no PermissionMode in the protocol yet, so `value` is
 * null and the menu shows it disabled. `key` is the number shortcut shown on the right.
 */
export const PERMISSION_MODES: { value: PermissionMode | null; label: string; hint: string; badge?: string; key: string }[] = [
  { value: null, label: 'Auto', hint: 'Claude handles permission decisions', badge: 'Recommended', key: '1' },
  { value: 'default', label: 'Manual', hint: 'Always ask before making changes', key: '2' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Automatically accept all file edits', key: '3' },
  { value: 'plan', label: 'Plan', hint: 'Create a plan before making changes', key: '4' },
  { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Accepts all permissions', key: '5' }
]

/** The effort slider's stops, left (Faster) to right (Smarter). The real app names xhigh "Extra". */
export const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra' },
  { value: 'max', label: 'Max' }
]

/** The stop the slider marks "Recommended" (the real popover marks one stop with a taller pill). */
export const RECOMMENDED_EFFORT: Effort = 'medium'

/** null = the account's default effort, shown as "Default". */
export function effortLabel(effort: Effort | null): string {
  if (effort == null) return 'Default'
  return EFFORTS.find((e) => e.value === effort)?.label ?? String(effort)
}

/** The model menu: the first `numbered` models get number shortcuts, the rest go under "More models". */
export function splitModels<T>(models: T[], numbered = 4): { main: T[]; more: T[] } {
  return { main: models.slice(0, numbered), more: models.slice(numbered) }
}

// Keyboard

export interface KeyLike {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export type ComposerKeyAction = 'send' | 'queue' | 'interrupt' | 'recall' | 'attach' | 'accept-suggestion' | 'swallow' | 'none'

/** The Stop button takes the Send button's place the moment a message goes out: a click this soon after is the send's second click, not a Stop. */
export const STOP_GUARD_MS = 500

/**
 * What a key in the composer's text box does when no slash or mention menu has it: Enter sends,
 * Ctrl+Enter (Cmd+Enter) adds to the send queue, Shift+Enter is a new line (the browser's own), Esc
 * interrupts a running turn, Up in an empty box recalls the last message, Ctrl+U opens the file picker
 * ("Add files or photos"), Tab in an empty box takes the suggested next prompt when one shows. `stop`:
 * the button shows Stop (a turn runs and the box has nothing to send); Enter then does nothing ('swallow',
 * no new line either): a second or repeating Enter after a send must never stop the turn it just started.
 */
export function composerKeyAction(e: KeyLike, s: { empty: boolean; busy: boolean; suggestion?: boolean; stop?: boolean }): ComposerKeyAction {
  if (e.key === 'Tab' && s.empty && s.suggestion && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) return 'accept-suggestion'
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    if (s.stop) return 'swallow'
    return e.ctrlKey || e.metaKey ? 'queue' : 'send'
  }
  if (e.key === 'Escape' && s.busy) return 'interrupt'
  if (e.key === 'ArrowUp' && s.empty && !e.shiftKey) return 'recall'
  if ((e.key === 'u' || e.key === 'U') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) return 'attach'
  return 'none'
}

// @-mentions

/** The `@word` being typed at the caret (the @ at the start or after whitespace), else null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!m) return null
  return { start: before.length - m[2].length - 1, query: m[2] }
}

/** Paths matching a mention query: basename prefix first, then path substring; case-insensitive. */
export function filterMentions(paths: string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/')
  const ranked: { p: string; rank: number }[] = []
  for (const p of new Set(paths)) {
    const lower = p.toLowerCase().replace(/\\/g, '/')
    const base = lower.slice(lower.lastIndexOf('/', lower.length - 2) + 1)
    let rank = -1
    if (!q || base.startsWith(q)) rank = 0
    else if (lower.includes(q)) rank = 1
    if (rank >= 0) ranked.push({ p, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.p.localeCompare(b.p))
  return ranked.slice(0, limit).map((r) => r.p)
}

/** The text after picking `path` for the mention at `m`: `@path ` replaces `@query`. */
export function applyMention(text: string, m: { start: number; query: string }, path: string): { text: string; caret: number } {
  const end = m.start + 1 + m.query.length
  const insert = `@${path} `
  const rest = text.slice(end).replace(/^ /, '')
  return { text: text.slice(0, m.start) + insert + rest, caret: m.start + insert.length }
}

// Dictation

/** Appends dictated words to the draft with exactly one space between them. */
export function appendDictation(text: string, said: string): string {
  const words = said.trim()
  if (!words) return text
  if (!text || /\s$/.test(text)) return text + words
  return `${text} ${words}`
}

/** Last path segment, for either slash style. */
export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

export function formatCount(n: number): string {
  return n.toLocaleString()
}

/**
 * What Create PR asks the chat. A chat often works on the default branch, so the work moves to a new
 * branch first; and gh is not on every PC, so any other GitHub tool the chat has will do.
 */
export function prAsk(draft: boolean): string {
  return (
    `Open a ${draft ? 'draft ' : ''}pull request for the work in this folder. ` +
    'If it is on the default branch, move it to a new branch first. ' +
    'Commit what is not committed, push the branch, and open the pull request with gh, ' +
    'or with another GitHub tool you have if gh is not installed. Reply with its link.'
  )
}

/** The suggested next prompt the empty box shows in place of its placeholder: only between turns. */
export function shownSuggestion(suggestion: string | null | undefined, s: { empty: boolean; busy: boolean }): string {
  const t = suggestion?.trim() ?? ''
  return t && s.empty && !s.busy ? t : ''
}

// New-session labels and tips

/**
 * The model trigger always names the model that runs, like the real "Opus 5.5". A chat that names none runs
 * DEFAULT_MODEL (owner, 2026-10-15: "it should default to Opus 5.5"); a bare family ('opus', how CliMayte names a Desk
 * chat's model) is named by that family's model in the menu.
 */
export function modelTriggerLabel(model: string | null, models: { value: string; label: string }[]): string {
  const m = model ?? DEFAULT_MODEL
  const listed = models.find((x) => x.value === m)
  if (listed) return listed.label
  if (/^(opus|sonnet|haiku|fable)$/i.test(m)) {
    const family = models.find((x) => x.value !== 'default' && x.value.toLowerCase().includes(m.toLowerCase()))
    return family?.label ?? `${m[0]!.toUpperCase()}${m.slice(1).toLowerCase()}`
  }
  return modelName(m)
}

/** The effort that runs, as the model chip and the Effort menu name it: the chat's own, else DEFAULT_EFFORT. */
export function runEffort(effort: Effort | null | undefined): Effort {
  return effort ?? DEFAULT_EFFORT
}

/** Used percent of an account's tighter window, or null when neither was read. */
export function accountUsedPct(a: Pick<AccountInfo, 'fiveHourPct' | 'weeklyPct'>): number | null {
  const read = [a.fiveHourPct, a.weeklyPct].filter((p): p is number => typeof p === 'number')
  return read.length ? Math.round(Math.max(...read)) : null
}

/** What an account is called on screen: the name on the account (its profile name), else its number; never a folder's
 *  name (owner, 2026-10-15: "the account folder name is useless ... I only ever want to see ... the name on the account"). */
export function accountShownName(a: { id: string; label: string; number?: number; name?: string | null }): string {
  const name = a.name?.trim()
  if (name) return name
  if (a.id === 'default') return 'Default login'
  const num = a.number ?? /^#(\d+)/.exec(a.label)?.[1]
  return num == null ? 'Account' : `#${num}`
}

/** The account menu's rows (owner, 2026-10-15: "only show desktop instances"): each login linked to a Claude Desktop
 *  instance, by the name on the account, then the chat's own account when it is not one of them. */
export function menuAccounts(accounts: AccountInfo[], currentId: string | null): AccountInfo[] {
  const byName = (a: AccountInfo, b: AccountInfo) => accountShownName(a).localeCompare(accountShownName(b), undefined, { sensitivity: 'base' })
  const desktop = accounts.filter((a) => a.desktop).sort(byName)
  const own = accounts.find((a) => a.id === currentId && !a.desktop)
  return own ? [...desktop, own] : desktop
}

/** The effort the trigger names: the chat's own, else the settings default, else the recommended stop. */
export function resolvedEffort(effort: Effort | null, settingsDefault: Effort | null | undefined): Effort {
  return effort ?? settingsDefault ?? RECOMMENDED_EFFORT
}

export interface Tip {
  id: string
  text: string
  /** Shown after the text in the link colour, like the real "/model". */
  link?: string
  /** What "Try it" does; a tip without one has no Try it. */
  action?: 'climayte' | 'model'
}

export const TIPS: Tip[] = [
  { id: 'climayte', text: 'Sub-agents run through CliMayte, so a long task will not block this chat.', action: 'climayte' },
  { id: 'model', text: 'Pick the model for this session anytime with', link: '/model', action: 'model' },
  { id: 'account', text: 'Put a chat on one account, or let it move when that runs out, from the circle under the box.' },
  { id: 'queue', text: 'Send while Claude works and the message waits its turn; Esc stops the turn.' }
]

export const TIPS_KEY = 'hydra-desk.tips-dismissed'

function dismissedTips(storage: DraftStorage | null): string[] {
  try {
    const v = JSON.parse(storage?.getItem(TIPS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * The first tip until any tip was closed, then null for good: showing the next one on the next chat read as
 * the banner coming back (owner, 2026-10-05: "Those all need to remember if I close them and stay closed").
 */
export function nextTip(storage: DraftStorage | null, tips: Tip[] = TIPS): Tip | null {
  return dismissedTips(storage).length ? null : (tips[0] ?? null)
}

/** Keeps a closed tip's id under TIPS_KEY; any id there ends the tips (nextTip). */
export function dismissTip(storage: DraftStorage | null, id: string): void {
  const gone = dismissedTips(storage)
  if (gone.includes(id)) return
  try {
    storage?.setItem(TIPS_KEY, JSON.stringify([...gone, id]))
  } catch {}
}

export type RequestItem = Extract<TranscriptItem, { kind: 'permission' | 'question' | 'plan' | 'elicitation' }>

/** The oldest open permission, question, plan or MCP elicitation request: the card the dock shows in place of the box. */
export function pendingRequest(items: readonly TranscriptItem[]): RequestItem | null {
  for (const it of items) {
    if ((it.kind === 'permission' || it.kind === 'question' || it.kind === 'plan' || it.kind === 'elicitation') && it.state === 'pending') return it
  }
  return null
}

/**
 * The request the dock shows for a chat. None while the chat is closed: no runtime waits on it (a request
 * left by a process that died), so its card could only answer 404 and would hide the box.
 */
export function dockedRequest(chat: { status: ChatStatus } | null, items: readonly TranscriptItem[]): RequestItem | null {
  return chat && chat.status !== 'closed' ? pendingRequest(items) : null
}

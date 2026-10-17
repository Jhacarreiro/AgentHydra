// The request bodies the chat routes take, checked before the manager sees them.

import type {
  CancelQueuedRequest,
  ChatPatch,
  CreateChatRequest,
  Effort,
  ElicitationAnswer,
  ForkChatRequest,
  ImageRef,
  ImportSessionRequest,
  PermissionDecision,
  PermissionMode,
  PinnedService,
  PlanDecision,
  QuestionAnswer,
  RewindChatRequest,
  SendNowRequest,
  SessionMetaPatch,
  SusLevel,
} from '@shared/protocol'
import { NOTE_MAX, SUS_LEVELS } from '@shared/protocol'
import { isUncOrDevicePath } from './cwd-move'
import { ChatError, checkCwd } from './chat-manager'
import { MANAGER_SLUG } from '../../../../server/src/manager-folders'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

// Input validation for the routes: each returns the parsed body or throws ChatError(400) with the reason.

export type Json = Record<string, unknown>

export function obj(body: unknown): Json {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatError(400, 'the body must be a JSON object')
  return body as Json
}

export function optString(b: Json, key: string): string | undefined {
  const v = b[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new ChatError(400, `${key} must be a string`)
  return v
}

export function optBool(b: Json, key: string): boolean | undefined {
  const v = b[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new ChatError(400, `${key} must be true or false`)
  return v
}

function optNullableString(b: Json, key: string): string | null | undefined {
  const v = b[key]
  if (v === undefined || v === null) return v as null | undefined
  if (typeof v !== 'string') throw new ChatError(400, `${key} must be a string or null`)
  return v
}

function optEffort(b: Json): Effort | null | undefined {
  const v = b.effort
  if (v === undefined || v === null) return v as null | undefined
  if (!EFFORTS.includes(v as Effort)) throw new ChatError(400, `effort must be one of ${EFFORTS.join(', ')} or null`)
  return v as Effort
}

function optMode(b: Json): PermissionMode | undefined {
  const v = b.permissionMode
  if (v === undefined) return undefined
  if (!MODES.includes(v as PermissionMode)) throw new ChatError(400, `permissionMode must be one of ${MODES.join(', ')}`)
  return v as PermissionMode
}

function optImages(b: Json): ImageRef[] | undefined {
  const v = b.images
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ChatError(400, 'images must be an array')
  return v.map((img, i) => {
    if (!img || typeof img !== 'object') throw new ChatError(400, `images[${i}] must be an object`)
    const o = img as Json
    if (typeof o.mediaType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(o.mediaType))
      throw new ChatError(400, `images[${i}].mediaType must be image/png, image/jpeg, image/gif or image/webp`)
    if (o.dataBase64 !== undefined && typeof o.dataBase64 !== 'string') throw new ChatError(400, `images[${i}].dataBase64 must be a string`)
    const ref: ImageRef = { mediaType: o.mediaType, ...originalSize(o) }
    if (typeof o.dataBase64 === 'string') ref.dataBase64 = o.dataBase64
    if (typeof o.name === 'string') ref.name = o.name
    return ref
  })
}

/** The size the window shrank a picture from (ImageRef.originalWidth and originalHeight), when both are whole pixels. */
export function originalSize(o: Json): Pick<ImageRef, 'originalWidth' | 'originalHeight'> {
  const w = o.originalWidth
  const h = o.originalHeight
  return Number.isInteger(w) && Number.isInteger(h) && (w as number) > 0 && (h as number) > 0 ? { originalWidth: w as number, originalHeight: h as number } : {}
}

export function parseCreate(body: unknown): CreateChatRequest {
  const b = obj(body)
  const cwd = optString(b, 'cwd')
  if (!cwd?.trim()) throw new ChatError(400, 'cwd is required')
  const req: CreateChatRequest = { cwd }
  const prompt = optString(b, 'prompt')
  if (prompt !== undefined) req.prompt = prompt
  const images = optImages(b)
  if (images) req.images = images
  const title = optString(b, 'title')
  if (title !== undefined) req.title = title
  const accountId = optString(b, 'accountId')
  if (accountId !== undefined) req.accountId = accountId
  if (optBool(b, 'accountPinned') === true) req.accountPinned = true
  const model = optNullableString(b, 'model')
  if (model !== undefined) req.model = model
  const effort = optEffort(b)
  if (effort !== undefined) req.effort = effort
  const mode = optMode(b)
  if (mode) req.permissionMode = mode
  const sus = optSus(b)
  if (sus !== undefined) req.sus = sus
  const delegate = optBool(b, 'delegateToCliMayte')
  if (delegate !== undefined) req.delegateToCliMayte = delegate
  const parentId = optString(b, 'parentId')
  if (parentId !== undefined) req.parentId = parentId
  const managerSlug = optString(b, 'managerSlug')
  if (managerSlug !== undefined) {
    if (!MANAGER_SLUG.test(managerSlug)) throw new ChatError(400, 'managerSlug is not a manager slug')
    req.managerSlug = managerSlug
  }
  return req
}

export function parseSend(body: unknown): { text: string; images?: ImageRef[] } {
  const b = obj(body)
  const text = optString(b, 'text') ?? ''
  const images = optImages(b)
  if (!text.trim() && !images?.length) throw new ChatError(400, 'text is required')
  return images ? { text, images } : { text }
}

export function parsePermission(body: unknown): PermissionDecision {
  const b = obj(body)
  if (b.decision !== 'allow' && b.decision !== 'session' && b.decision !== 'always' && b.decision !== 'deny')
    throw new ChatError(400, 'decision must be allow, session, always or deny')
  const d: PermissionDecision = { decision: b.decision }
  const message = optString(b, 'message')
  if (message !== undefined) d.message = message
  return d
}

export function parseQuestion(body: unknown): QuestionAnswer {
  const b = obj(body)
  const skip = optBool(b, 'skip')
  if (skip) return { skip: true }
  const answers = b.answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ChatError(400, 'answers (question -> answer) or skip: true is required')
  for (const [k, v] of Object.entries(answers)) if (typeof v !== 'string') throw new ChatError(400, `the answer to ${JSON.stringify(k)} must be a string`)
  const out: QuestionAnswer = { answers: answers as Record<string, string> }
  const pictures = b.images
  if (pictures !== undefined) {
    if (!pictures || typeof pictures !== 'object' || Array.isArray(pictures)) throw new ChatError(400, 'images (question -> pictures) must be an object')
    out.images = {}
    for (const [k, v] of Object.entries(pictures)) out.images[k] = optImages({ images: v }) ?? []
  }
  return out
}

export function parsePlan(body: unknown): PlanDecision {
  const b = obj(body)
  const approve = optBool(b, 'approve')
  if (approve === undefined) throw new ChatError(400, 'approve (true or false) is required')
  const d: PlanDecision = { approve }
  const feedback = optString(b, 'feedback')
  if (feedback !== undefined) d.feedback = feedback
  const mode = optMode(b)
  if (mode) d.mode = mode
  return d
}

/** The shape only: the values are checked against the request's own form fields when it is answered. */
export function parseElicitation(body: unknown): ElicitationAnswer {
  const b = obj(body)
  if (b.action !== 'accept' && b.action !== 'decline') throw new ChatError(400, 'action must be accept or decline')
  const a: ElicitationAnswer = { action: b.action }
  if (b.values === undefined) return a
  if (!b.values || typeof b.values !== 'object' || Array.isArray(b.values)) throw new ChatError(400, 'values must be an object (field name -> value)')
  a.values = b.values as ElicitationAnswer['values']
  return a
}

const GROUP_MAX = 60

/** A sidebar group name: trimmed, 1-60 chars, or null (back to the folder's group). */
function optGroup(b: Json): string | null | undefined {
  const v = optNullableString(b, 'group')
  if (v === undefined || v === null) return v
  const name = v.trim()
  if (!name || name.length > GROUP_MAX) throw new ChatError(400, `group must be 1-${GROUP_MAX} characters or null`)
  return name
}

const PATCH_KEYS = ['title', 'pinned', 'archived', 'unread', 'model', 'effort', 'permissionMode', 'delegateToCliMayte', 'accountId', 'accountPinned', 'group', 'cwd', 'note', 'service', 'sus']
function optSus(b: Record<string, unknown>): SusLevel | undefined {
  if (b.sus === undefined) return undefined
  if (!SUS_LEVELS.includes(b.sus as SusLevel)) throw new ChatError(400, `sus is one of ${SUS_LEVELS.join(', ')}`)
  return b.sus as SusLevel
}

const PINNABLE: PinnedService[] = ['codex', 'chatgpt']

/** POST /api/chats/import-desk: `ids`, the chats to copy (every one when absent). */
export function parseImportDesk(body: unknown): { ids?: string[] } {
  const b = body === undefined || body === null ? {} : obj(body)
  if (b.ids === undefined) return {}
  if (!Array.isArray(b.ids) || b.ids.some((x) => typeof x !== 'string')) throw new ChatError(400, 'ids must be a list of chat ids')
  return { ids: b.ids as string[] }
}

export function parsePatch(body: unknown): ChatPatch {
  const b = obj(body)
  const unknown = Object.keys(b).filter((k) => !PATCH_KEYS.includes(k))
  if (unknown.length) throw new ChatError(400, `cannot change ${unknown.join(', ')}; a patch takes ${PATCH_KEYS.join(', ')}`)
  const p: ChatPatch = {}
  const title = optString(b, 'title')
  if (title !== undefined) {
    if (!title.trim()) throw new ChatError(400, 'title cannot be empty')
    p.title = title
  }
  for (const k of ['pinned', 'archived', 'unread', 'delegateToCliMayte', 'accountPinned'] as const) {
    const v = optBool(b, k)
    if (v !== undefined) p[k] = v
  }
  const model = optNullableString(b, 'model')
  if (model !== undefined) p.model = model
  const effort = optEffort(b)
  if (effort !== undefined) p.effort = effort
  const mode = optMode(b)
  if (mode) p.permissionMode = mode
  const accountId = optString(b, 'accountId')
  if (accountId !== undefined) {
    if (!accountId.trim()) throw new ChatError(400, 'accountId cannot be empty')
    p.accountId = accountId
  }
  const group = optGroup(b)
  if (group !== undefined) p.group = group
  const cwd = optString(b, 'cwd')
  if (cwd !== undefined) {
    if (isUncOrDevicePath(cwd)) throw new ChatError(400, `cwd must be a local folder, not a share or device path: ${JSON.stringify(cwd)}`)
    p.cwd = checkCwd(cwd)
  }
  const note = optNote(b)
  if (note !== undefined) p.note = note
  const sus = optSus(b)
  if (sus !== undefined) p.sus = sus
  if (b.service !== undefined) {
    if (b.service !== null && !PINNABLE.includes(b.service as PinnedService)) throw new ChatError(400, `service is one of ${PINNABLE.join(', ')}, or null for Claude`)
    p.service = b.service as PinnedService | null
  }
  return p
}

/** A chat's note (the row menu's Add note…): trimmed, at most NOTE_MAX characters; null or empty is no note. */
function optNote(b: Record<string, unknown>): string | null | undefined {
  const note = optNullableString(b, 'note')
  if (note === undefined) return undefined
  const t = note?.trim() ?? ''
  if (t.length > NOTE_MAX) throw new ChatError(400, `a note is at most ${NOTE_MAX} characters`)
  return t || null
}

const META_KEYS = ['title', 'pinned', 'archived', 'unread', 'group', 'note', 'unassigned']

/** The marks on an outside session; a null or empty title goes back to the session's own. */
export function parseSessionMeta(body: unknown): SessionMetaPatch {
  const b = obj(body)
  const unknown = Object.keys(b).filter((k) => !META_KEYS.includes(k))
  if (unknown.length) throw new ChatError(400, `cannot change ${unknown.join(', ')}; the marks are ${META_KEYS.join(', ')}`)
  const p: SessionMetaPatch = {}
  const title = optNullableString(b, 'title')
  if (title !== undefined) p.title = title?.trim().slice(0, 200) || null
  for (const k of ['pinned', 'archived', 'unread', 'unassigned'] as const) {
    const v = optBool(b, k)
    if (v !== undefined) p[k] = v
  }
  const group = optGroup(b)
  if (group !== undefined) p.group = group
  const note = optNote(b)
  if (note !== undefined) p.note = note
  return p
}

export function parseImport(body: unknown): ImportSessionRequest {
  const b = obj(body)
  const sessionId = optString(b, 'sessionId')
  if (!sessionId?.trim()) throw new ChatError(400, 'sessionId is required')
  const req: ImportSessionRequest = { sessionId: sessionId.trim() }
  const cwd = optString(b, 'cwd')
  if (cwd !== undefined) req.cwd = cwd
  const configDir = optNullableString(b, 'configDir')
  if (configDir !== undefined) req.configDir = configDir
  const title = optString(b, 'title')
  if (title !== undefined) req.title = title
  const fork = optBool(b, 'fork')
  if (fork !== undefined) req.fork = fork
  const at = optString(b, 'at')
  if (at?.trim()) req.at = at.trim()
  return req
}

/** Send now's request: the bubble's item id, when one is given. */
export function parseSendNow(body: unknown): SendNowRequest {
  const itemId = optString(obj(body), 'itemId')
  return itemId?.trim() ? { itemId: itemId.trim() } : {}
}

export function parseCancelQueued(body: unknown): CancelQueuedRequest {
  const itemId = optString(obj(body), 'itemId')
  if (!itemId?.trim()) throw new ChatError(400, 'itemId is required')
  return { itemId: itemId.trim() }
}

/** A fork's request: an empty body forks the whole chat. */
export function parseFork(body: unknown): ForkChatRequest {
  const at = optString(obj(body), 'at')
  return at?.trim() ? { at: at.trim() } : {}
}

/** Undo's request: the owner's message the chat goes back to before. */
export function parseRewind(body: unknown): RewindChatRequest {
  const at = optString(obj(body), 'at')?.trim()
  if (!at) throw new ChatError(400, 'at (the id of your message to undo) is required')
  return { at }
}

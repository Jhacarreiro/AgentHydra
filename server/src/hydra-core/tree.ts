import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type CatalogEntry, KINDS, type Kind, loadCatalog, loadRef, loadText } from './catalog'
import { findPage, matchOf, PAGE } from './find'
import {
  addPick,
  emptyDoc,
  type HydraDoc,
  leadLine,
  leadName,
  parseHydra,
  renderHydra,
  scopeLine,
} from './hydra-md'
import { appendLog } from './log'
import { chatPaths } from './paths'

export type Step =
  | 'q1'
  | 'q2'
  | 'q3'
  | 'q4'
  | 'q5'
  | 'q6'
  | 'q6pick'
  | 'q7'
  | 'q7pick'
  | 'q8'
  | 'q8pick'
  | 'q9'
  | 'done'

interface Group {
  label: string
  need: string
  kinds?: Kind[]
  mode?: string
  start: number
  ids: string[]
}

interface Pick {
  id: string
  mode?: 'hire'
}

export interface RunState {
  run: number
  step: Step
  msg: string
  steps: string[]
  tier?: string
  team?: string
  lead?: string | null
  picks: Pick[]
  groups: Group[]
  shown: string[]
  retried: boolean
}

interface Parsed {
  kw: string
  text?: string
  n?: number
  picks?: string[]
  label?: string
  roles?: { label: string; need: string }[]
}

type Files = ReturnType<typeof chatPaths>

interface Ctx {
  dir: string
  chat: string
  cat: Map<string, CatalogEntry>
  now: Date
  files: Files
}

type Reply = Record<string, unknown>

const QUESTIONS: Record<Exclude<Step, 'done'>, string> = {
  q1: "Do you need anything you don't already have for this message? Answer `no`, or `yes: <what you need>`.",
  q2: '',
  q3: 'Do it yourself, or delegate? `myself` or `delegate`.',
  q4: 'What tier is it, 1-5? 1 = one worker for minutes, 2 = one worker for an hour, 3 = a few workers or one field for a day, 4 = several fields in parallel, 5 = a multi-team build. Sized for an AI, never months.',
  q5: 'How big a team? Any number (1, 3, 5, 20).',
  q6: 'Who should you be? Describe the lead this needs in plain words.',
  q6pick: 'Pick one id, `more`, or `none: <a better description>`.',
  q7: 'Who and what do you need under you? One role per line, e.g. `testing: real visitors for the signup page`.',
  q7pick: 'Pick ids (`picks`), `more <role>`, or `none`.',
  q8: 'Which knowledge does this touch? Plain words, or `none`.',
  q8pick: 'Pick ids (`picks`), `more`, or `none`.',
  q9: 'Your plan in 3-7 lines.',
}

const EXAMPLE: Record<Exclude<Step, 'done'>, string> = {
  q1: '`yes: move the notes into the archive folder`',
  q2: '`mid` or `new`',
  q3: '`myself` or `delegate`',
  q4: '`3`',
  q5: '`5`',
  q6: '`a lead who knows dashboard design`',
  q6pick: '`2`, `person:iris-ui-design`, or `none`',
  q7: '`testing: real visitors for the signup page`, or `none`',
  q7pick: '`1 3`, `more testing`, or `none`',
  q8: '`dashboard styling`, or `none`',
  q8pick: '`1`, `more`, or `none`',
  q9: '`Rebuild the layout first, then test it with two visitors.`',
}

const PEOPLE_AND_TOOLS: Kind[] = ['person', 'instrument', 'worker']
const KNOWLEDGE: Kind[] = ['knowledge', 'skill']
const TOKEN = /^(\d+|(?:person|instrument|worker|knowledge|skill):[a-z0-9-]+)$/

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

function catalogFor(dir: string, now: Date): Map<string, CatalogEntry> {
  const cat = loadCatalog(dir)
  for (const s of cat.skipped) appendLog(dir, { event: 'skip', ...s }, now)
  return cat.entries
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function readState(file: string): RunState | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RunState) : null
}

function readDoc(files: Files): HydraDoc | null {
  return existsSync(files.hydraMd) ? parseHydra(readFileSync(files.hydraMd, 'utf8')) : null
}

/** Folder entries q1 shows in full; a folder with many rules would otherwise fill the chat on every message. */
const FOLDER_SHOWN = 3

/** The knowledge for the chat's folder: its main entries (tagged `repo`) in full, the rest as a count that core_find reaches. */
function folderKnowledge(cat: Map<string, CatalogEntry>, cwd: string) {
  if (!cwd) return { folderKnowledge: [] }
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const here = norm(cwd)
  const all = [...cat.values()].filter(
    (e) =>
      e.kind === 'knowledge' &&
      (e.folders ?? []).some((f) => here === norm(f) || here.startsWith(`${norm(f)}/`)),
  )
  const main = all.filter((e) => (e.tags ?? []).includes('repo'))
  const shown = (main.length ? main : all).slice(0, FOLDER_SHOWN)
  const more = all.length - shown.length
  return {
    folderKnowledge: shown.map((e) => ({ ...matchOf(e), load: loadRef(e) })),
    ...(more > 0
      ? {
          folderMore: {
            count: more,
            find: 'core_find { need: "<what you are about to touch>", kind: "knowledge", chat } finds the rest of this folder\'s rules',
          },
        }
      : {}),
  }
}

export function scope(dir: string, chat: string, now = new Date()) {
  const files = chatPaths(dir, chat)
  if (!existsSync(files.prompt))
    throw new Error('no message for this chat yet: the core hook writes prompt.txt first')
  const cat = catalogFor(dir, now)
  const doc = readDoc(files)
  const prev = readState(files.state)
  const state: RunState = {
    run: (prev?.run ?? 0) + 1,
    step: 'q1',
    msg: squash(readFileSync(files.prompt, 'utf8')).slice(0, 80).replace(/"/g, "'"),
    steps: [],
    picks: [],
    groups: [],
    shown: [],
    retried: false,
  }
  writeText(files.state, JSON.stringify(state, null, 2))
  appendLog(dir, { chat, run: state.run, step: 'start' }, now)
  const cwd = existsSync(files.cwd) ? readFileSync(files.cwd, 'utf8').trim() : ''
  return {
    run: state.run,
    step: 'q1' as Step,
    question: QUESTIONS.q1,
    context: {
      hydraMd: doc
        ? { exists: true, path: files.hydraMd, lead: leadName(doc), tier: doc.tier }
        : { exists: false, path: files.hydraMd },
      ...folderKnowledge(cat, cwd),
    },
  }
}

function group(label: string, need: string, kinds?: Kind[], mode?: string): Group {
  return { label, need, kinds, mode, start: 0, ids: [] }
}

function fill(ctx: Ctx, g: Group): void {
  g.ids = findPage(ctx.cat.values(), g.need, { kinds: g.kinds, mode: g.mode, start: g.start }).ids
  if (!g.ids.length)
    appendLog(ctx.dir, { chat: ctx.chat, event: 'find', need: g.need, empty: true }, ctx.now)
}

function pageGroup(ctx: Ctx, g: Group): void {
  for (const id of g.ids)
    appendLog(ctx.dir, { chat: ctx.chat, event: 'miss', id, need: g.need }, ctx.now)
  g.start += PAGE
  fill(ctx, g)
}

function view(ctx: Ctx, state: RunState) {
  const out: Record<string, unknown>[] = []
  state.shown = []
  for (const g of state.groups)
    for (const id of g.ids) {
      const e = ctx.cat.get(id)
      if (!e) continue
      state.shown.push(id)
      out.push({ n: state.shown.length, group: g.label, ...matchOf(e) })
    }
  return out
}

function questionOf(step: Step, doc: HydraDoc | null): string {
  if (step === 'done') return ''
  if (step === 'q2') {
    const head = doc?.plan[0] ?? 'no plan line yet'
    return `Mid-project (this message fits your hydra.md: ${doc ? leadName(doc) : 'none'}, ${head}) or new work? \`mid\` or \`new\`.`
  }
  return QUESTIONS[step]
}

function next(ctx: Ctx, state: RunState, doc: HydraDoc | null): Reply {
  return { step: state.step, question: questionOf(state.step, doc), matches: view(ctx, state) }
}

function reject(ctx: Ctx, state: RunState, doc: HydraDoc | null, why: string): Reply {
  state.steps.pop()
  return { ...next(ctx, state, doc), error: why }
}

function end(
  ctx: Ctx,
  state: RunState,
  doc: HydraDoc | null,
  verdict: string,
  body: Reply,
  write = true,
): Reply {
  state.step = 'done'
  const reply: Reply = { verdict, ...body }
  if (doc && write) {
    doc.updated = ctx.now.toISOString()
    doc.scopeLog.push(scopeLine(ctx.now, state.msg, verdict, state.steps))
    writeText(ctx.files.hydraMd, renderHydra(doc))
    if (verdict === 'hydra') reply.hydra_md = renderHydra(doc)
  }
  appendLog(ctx.dir, { chat: ctx.chat, run: state.run, step: 'end', verdict }, ctx.now)
  return reply
}

function resolve(tokens: string[], state: RunState, cat: Map<string, CatalogEntry>) {
  const ids: string[] = []
  const bad: string[] = []
  for (const t of tokens) {
    const id = /^\d+$/.test(t) ? state.shown[Number(t) - 1] : t
    if (id && cat.has(id)) ids.push(id)
    else bad.push(t)
  }
  return { ids: [...new Set(ids)], bad }
}

function addPicks(state: RunState, ids: string[], mode?: 'hire'): void {
  for (const id of ids) {
    const have = state.picks.find((p) => p.id === id)
    if (!have) state.picks.push(mode ? { id, mode } : { id })
    else if (mode && !have.mode) have.mode = mode
  }
}

function pickHows(ctx: Ctx, state: RunState) {
  return state.picks.flatMap((p) => {
    const e = ctx.cat.get(p.id)
    return e ? [{ id: e.id, how: e.how }] : []
  })
}

function findGroup(state: RunState, label?: string): Group | undefined {
  if (!label) return state.groups.length === 1 ? state.groups[0] : undefined
  return state.groups.find((g) => g.label.toLowerCase() === label.toLowerCase())
}

function finishPlan(ctx: Ctx, state: RunState, prev: HydraDoc | null, plan: string): Reply {
  const doc = emptyDoc(ctx.now)
  doc.scopeLog = prev?.scopeLog ?? []
  doc.tier = state.tier ?? '-'
  doc.team = state.team ?? '-'
  const lead = state.lead ? ctx.cat.get(state.lead) : undefined
  doc.lead = lead ? leadLine(lead) : null
  doc.plan = plan
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const p of state.picks) {
    const e = ctx.cat.get(p.id)
    if (e) addPick(doc, e, p.mode)
  }
  return end(ctx, state, doc, 'hydra', { become: lead ? loadText(lead) : null })
}

function route(ctx: Ctx, state: RunState, doc: HydraDoc | null, p: Parsed): Reply {
  switch (state.step) {
    case 'q1': {
      if (p.kw === 'no') return end(ctx, state, doc, 'go', { say: 'Go do it.' })
      state.groups = [group('need', p.text ?? state.msg)]
      fill(ctx, state.groups[0])
      state.step = doc ? 'q2' : 'q3'
      return next(ctx, state, doc)
    }
    case 'q2': {
      if (p.kw === 'mid') {
        const added: Reply[] = []
        const hd = doc ?? emptyDoc(ctx.now)
        for (const pk of state.picks) {
          const e = ctx.cat.get(pk.id)
          if (e && addPick(hd, e, pk.mode)) added.push({ id: e.id, how: e.how })
        }
        return end(ctx, state, hd, 'go', { added })
      }
      state.step = 'q3'
      return next(ctx, state, doc)
    }
    case 'q3': {
      if (p.kw === 'myself')
        return end(ctx, state, doc, 'go', { picks: pickHows(ctx, state) }, false)
      state.step = 'q4'
      return next(ctx, state, doc)
    }
    case 'q4':
      state.tier = String(p.n)
      state.step = 'q5'
      return next(ctx, state, doc)
    case 'q5':
      state.team = String(p.n)
      state.groups = []
      state.step = 'q6'
      return next(ctx, state, doc)
    case 'q6': {
      state.groups = [group('lead', p.text ?? state.msg, ['person'], 'become')]
      fill(ctx, state.groups[0])
      state.step = 'q6pick'
      return next(ctx, state, doc)
    }
    case 'q6pick': {
      if (p.kw === 'none' && p.text) {
        state.groups = [group('lead', p.text, ['person'], 'become')]
        fill(ctx, state.groups[0])
        return next(ctx, state, doc)
      }
      if (p.kw === 'more') {
        const g = findGroup(state)
        if (g) pageGroup(ctx, g)
        return next(ctx, state, doc)
      }
      if (p.kw === 'none') {
        state.lead = null
      } else {
        const { ids } = resolve(p.picks ?? [], state, ctx.cat)
        const lead = ids.find((id) => ctx.cat.get(id)?.kind === 'person')
        if (!lead)
          return reject(
            ctx,
            state,
            doc,
            'no person matched: pick a number or an id from the matches',
          )
        state.lead = lead
      }
      state.groups = []
      state.step = 'q7'
      return next(ctx, state, doc)
    }
    case 'q7': {
      if (p.kw === 'none') {
        state.groups = []
        state.step = 'q8'
        return next(ctx, state, doc)
      }
      state.groups = (p.roles ?? []).map((r) => group(r.label, r.need, PEOPLE_AND_TOOLS))
      for (const g of state.groups) fill(ctx, g)
      state.step = 'q7pick'
      return next(ctx, state, doc)
    }
    case 'q7pick': {
      if (p.kw === 'more') {
        const g = findGroup(state, p.label)
        if (g) pageGroup(ctx, g)
        return next(ctx, state, doc)
      }
      if (p.kw === 'picks') addPicks(state, resolve(p.picks ?? [], state, ctx.cat).ids, 'hire')
      state.groups = []
      state.step = 'q8'
      return next(ctx, state, doc)
    }
    case 'q8': {
      if (p.kw === 'none') {
        state.groups = []
        state.step = 'q9'
        return next(ctx, state, doc)
      }
      state.groups = [group('knowledge', p.text ?? state.msg, KNOWLEDGE)]
      fill(ctx, state.groups[0])
      state.step = 'q8pick'
      return next(ctx, state, doc)
    }
    case 'q8pick': {
      if (p.kw === 'more') {
        const g = findGroup(state)
        if (g) pageGroup(ctx, g)
        return next(ctx, state, doc)
      }
      if (p.kw === 'picks') addPicks(state, resolve(p.picks ?? [], state, ctx.cat).ids)
      state.groups = []
      state.step = 'q9'
      return next(ctx, state, doc)
    }
    case 'q9':
      return finishPlan(ctx, state, doc, p.text ?? state.msg)
    default:
      throw new Error('no run for this chat: call core_scope first')
  }
}

function pickAnswer(t: string): Parsed | null {
  if (/^none\b/i.test(t))
    return { kw: 'none', text: t.replace(/^none\b\s*:?\s*/i, '') || undefined }
  if (/^more\b/i.test(t)) return { kw: 'more', label: t.replace(/^more\b\s*/i, '') || undefined }
  const toks = t.split(/[\s,]+/).filter(Boolean)
  return toks.length && toks.every((x) => TOKEN.test(x)) ? { kw: 'picks', picks: toks } : null
}

function parseRole(line: string): { label: string; need: string } {
  const m = line.match(/^[-*]?\s*([^:]{1,60}):\s*(.+)$/)
  return m ? { label: m[1].trim(), need: m[2].trim() } : { label: line.slice(0, 60), need: line }
}

function parse(step: Step, raw: string): Parsed | null {
  const t = squash(raw)
  switch (step) {
    case 'q1': {
      if (/^no\b/i.test(t)) return { kw: 'no' }
      const y = t.match(/^yes\b\s*:?\s*(.+)$/i)
      return y ? { kw: 'yes', text: y[1].trim() } : null
    }
    case 'q2':
      return /^mid\b/i.test(t) ? { kw: 'mid' } : /^new\b/i.test(t) ? { kw: 'new' } : null
    case 'q3':
      return /^myself\b/i.test(t)
        ? { kw: 'myself' }
        : /^delegate\b/i.test(t)
          ? { kw: 'delegate' }
          : null
    case 'q4': {
      const m = t.match(/^([1-5])\b/)
      return m ? { kw: 'tier', n: Number(m[1]) } : null
    }
    case 'q5': {
      const m = t.match(/^(\d{1,3})\b/)
      return m && Number(m[1]) >= 1 ? { kw: 'team', n: Number(m[1]) } : null
    }
    case 'q6':
      return t ? { kw: 'lead', text: t } : null
    case 'q6pick':
    case 'q7pick':
    case 'q8pick':
      return pickAnswer(t)
    case 'q7': {
      if (/^none\b/i.test(t)) return { kw: 'none', roles: [] }
      const roles = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map(parseRole)
      return roles.length ? { kw: 'roles', roles } : null
    }
    case 'q8':
      return /^none\b/i.test(t) ? { kw: 'none' } : t ? { kw: 'need', text: t } : null
    case 'q9':
      return raw.trim() ? { kw: 'plan', text: raw.trim() } : null
    default:
      return null
  }
}

function fallback(step: Step, state: RunState): Parsed {
  switch (step) {
    case 'q1':
      return { kw: 'yes', text: state.msg }
    case 'q2':
      return { kw: 'new' }
    case 'q3':
      return { kw: 'myself' }
    case 'q4':
      return { kw: 'tier', n: 2 }
    case 'q5':
      return { kw: 'team', n: 1 }
    case 'q6':
      return { kw: 'lead', text: state.msg }
    case 'q7':
      return { kw: 'none', roles: [] }
    case 'q9':
      return { kw: 'plan', text: state.msg }
    default:
      return { kw: 'none' }
  }
}

export function answer(
  dir: string,
  chat: string,
  input: { answer: string; picks?: string[] },
  now = new Date(),
): Reply {
  const files = chatPaths(dir, chat)
  const state = readState(files.state)
  if (!state || state.step === 'done')
    throw new Error('no run for this chat: call core_scope first')
  const cat = catalogFor(dir, now)
  const ctx: Ctx = { dir, chat, cat, now, files }
  const doc = readDoc(files)
  const step = state.step
  const extra = resolve(input.picks ?? [], state, cat)
  addPicks(state, extra.ids)
  let parsed = parse(step, input.answer ?? '')
  if (!parsed) {
    if (!state.retried) {
      state.retried = true
      writeText(files.state, JSON.stringify(state, null, 2))
      const shown = squash(input.answer ?? '').slice(0, 80)
      return {
        step,
        question: questionOf(step, doc),
        retry: `Could not read "${shown}". Example: ${EXAMPLE[step as Exclude<Step, 'done'>]}`,
        matches: view(ctx, state),
      }
    }
    parsed = fallback(step, state)
  }
  state.retried = false
  state.steps.push(`${step} ${parsed.kw}`)
  appendLog(
    dir,
    {
      chat,
      run: state.run,
      step,
      answer: squash(input.answer ?? '').slice(0, 200),
      shown: state.shown,
    },
    now,
  )
  const reply = route(ctx, state, doc, parsed)
  if (extra.bad.length) reply.skipped = extra.bad
  writeText(files.state, JSON.stringify(state, null, 2))
  return reply
}

const pages = new Map<string, { start: number; ids: string[] }>()

export function findTool(
  dir: string,
  args: { need: string; kind?: string; more?: boolean; chat?: string },
  now = new Date(),
) {
  const cat = catalogFor(dir, now)
  const need = squash(args.need)
  if (!need) throw new Error('need is empty: say what you are looking for')
  if (args.kind && !(KINDS as readonly string[]).includes(args.kind))
    throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  const kinds = args.kind ? [args.kind as Kind] : undefined
  const key = [args.chat ?? '', need, args.kind ?? ''].join('\u0000')
  const prev = pages.get(key)
  let start = 0
  if (args.more) {
    for (const id of prev?.ids ?? [])
      appendLog(dir, { chat: args.chat, event: 'miss', id, need }, now)
    start = (prev?.start ?? 0) + PAGE
  }
  const r = findPage(cat.values(), need, { kinds, start })
  pages.set(key, { start, ids: r.ids })
  if (!r.ids.length) appendLog(dir, { chat: args.chat, event: 'find', need, empty: true }, now)
  const matches = r.ids.flatMap((id) => {
    const e = cat.get(id)
    return e ? [matchOf(e)] : []
  })
  return { matches, more: r.total > start + PAGE, total: r.total }
}

export function report(
  dir: string,
  args: { chat: string; outcome: string; note: string; overruled?: string[] },
  now = new Date(),
) {
  const state = readState(chatPaths(dir, args.chat).state)
  const run = state?.run ?? null
  appendLog(
    dir,
    {
      chat: args.chat,
      run,
      event: 'report',
      outcome: args.outcome,
      note: args.note,
      overruled: args.overruled ?? [],
    },
    now,
  )
  return { ok: true, run }
}

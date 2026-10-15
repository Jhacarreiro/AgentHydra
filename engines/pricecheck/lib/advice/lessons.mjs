// A lesson is one piece of advice that went bad, copied from this PC's advice log into the lessons folder beside lib/,
// inside the git checkout, so the next sync carries it to every other PC. Kinds: undone | misled (reconcile outcomes),
// wrong | undone-feedback (feedback verdicts wrong | undone). No absolute path and no user-home path is ever written.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendRow, readRows } from './log.mjs'

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const lessonsDir = () => process.env.PRICECHECK_LESSONS_DIR || path.join(PACKAGE, 'lessons')

export const machineName = () => {
  const raw = process.env.PRICECHECK_MACHINE || os.hostname() || 'unknown'
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

const slashes = (p) => String(p).replace(/\\/g, '/')
const isAbsolute = (p) => /^([a-z]:)?\//i.test(p)

function relativeTo(root, p) {
  const file = slashes(p)
  const base = root ? slashes(root).replace(/\/+$/, '') : null
  if (base && file.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return file.slice(base.length + 1)
  return isAbsolute(file) ? null : file
}

function scrub(text, root) {
  if (typeof text !== 'string') return text
  let out = slashes(text)
  for (const secret of [root && slashes(root), slashes(os.homedir())].filter(Boolean)) {
    out = out.split(secret).join('<repo>')
    out = out.split(secret.toLowerCase()).join('<repo>')
  }
  return out
}

export function recordLesson(lesson, root) {
  try {
    const machine = machineName()
    const file = path.join(lessonsDir(), `${machine}.jsonl`)
    if (readRows(file).some((r) => r.id === lesson.id && r.kind === lesson.kind)) return false
    const files = Array.isArray(lesson.files)
      ? lesson.files.map((f) => relativeTo(root, typeof f === 'string' ? f : f?.file)).filter(Boolean)
      : undefined
    const row = {
      id: lesson.id,
      at: lesson.at ?? new Date().toISOString(),
      machine,
      repo: lesson.repo ?? (root ? path.basename(root) : undefined),
      page: lesson.page == null ? undefined : (relativeTo(root, lesson.page) ?? undefined),
      files,
      points: lesson.points,
      pointsAfter: lesson.pointsAfter,
      kind: lesson.kind,
      claim: scrub(lesson.claim, root),
      why: scrub(lesson.why, root),
      adviceKind: lesson.adviceKind,
      version: lesson.version,
      adviceAt: lesson.adviceAt,
    }
    appendRow(file, row)
    return true
  } catch {
    // a lesson is advisory: a failed write must not break the command that produced it
    return false
  }
}

// The bad advice behind a row, as lesson fields. advice may be undefined (loose feedback).
const fromAdvice = (advice) =>
  advice
    ? { repo: advice.repo, page: advice.page, files: advice.files, points: advice.points, claim: advice.claim, adviceKind: advice.kind, version: advice.version, adviceAt: advice.at }
    : {}

export function lessonFromOutcome(outcome, advice) {
  if (outcome.kind !== 'undone' && outcome.kind !== 'misled') return false
  return recordLesson(
    { ...fromAdvice(advice), id: `${outcome.adviceId}:${outcome.snapshotAt ?? ''}`, at: outcome.at, kind: outcome.kind, pointsAfter: outcome.points },
    advice?.root,
  )
}

export function lessonFromFeedback(feedback, advice) {
  if (feedback.verdict !== 'wrong' && feedback.verdict !== 'undone') return false
  const root = feedback.root ?? advice?.root
  return recordLesson(
    {
      ...fromAdvice(advice),
      id: feedback.id,
      at: feedback.at,
      kind: feedback.verdict === 'undone' ? 'undone-feedback' : 'wrong',
      page: feedback.page ?? advice?.page,
      claim: feedback.claim ?? advice?.claim,
      why: feedback.why,
    },
    root,
  )
}

export function readLessons() {
  const dir = lessonsDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readRows(path.join(dir, f)))
}

export function sharedView() {
  const lessons = readLessons().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const tally = {}
  for (const l of lessons) tally[l.machine ?? 'unknown'] = (tally[l.machine ?? 'unknown'] ?? 0) + 1
  const lines = []
  const repos = [...new Set(lessons.map((l) => l.repo ?? '-'))]
  for (const repo of repos) {
    lines.push(`${repo}`)
    for (const l of lessons.filter((x) => (x.repo ?? '-') === repo)) {
      const pts = l.points == null ? '-' : l.pointsAfter == null ? `${l.points}` : `${l.points} -> ${l.pointsAfter}`
      lines.push(`  ${l.machine ?? 'unknown'} ${l.kind} ${l.page ?? '-'} ${pts} ${l.claim ?? ''}${l.why ? ` (${l.why})` : ''}`.trimEnd())
    }
  }
  const total = Object.entries(tally).map(([m, n]) => `${m} ${n}`).join(', ')
  lines.push(lessons.length === 0 ? 'no lessons yet' : total)
  return { lessons, tally, lines }
}

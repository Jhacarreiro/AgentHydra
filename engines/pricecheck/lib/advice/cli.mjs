import path from 'node:path'
import { adviceFile, appendRow, newId, readRows } from './log.mjs'
import { lessonFromFeedback, sharedView } from './lessons.mjs'
import { summarize } from './reconcile.mjs'

const VALUED = new Set(['--root', '--verdict', '--claim', '--advice', '--page', '--why', '--by'])
const SWITCHES = new Set(['--all', '--json', '--shared'])
const VERDICTS = ['wrong', 'undone', 'right']
const SHOWN = 20

function parse(argv) {
  const opts = {}
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (SWITCHES.has(arg)) opts[arg.slice(2)] = true
    else if (VALUED.has(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      opts[arg.slice(2)] = argv[++i]
    } else throw new Error(`unknown option ${arg}`)
  }
  return opts
}

const isOf = (root) => (r) => r.root && path.resolve(r.root) === root

function listAdvice(root, opts) {
  const summary = summarize(root)
  const rows = readRows(adviceFile())
  const mine = rows.filter((r) => r.type === 'advice' && isOf(root)(r))
  const shown = opts.all ? mine : mine.slice(-SHOWN)
  const items = shown.map((a) => {
    const outcomes = rows.filter((r) => r.type === 'outcome' && r.adviceId === a.id)
    const feedback = rows.filter((r) => r.type === 'feedback' && r.adviceId === a.id).map((r) => r.verdict)
    const state = outcomes.at(-1)?.kind ?? (feedback.at(-1) === 'undone' ? 'undone' : null)
    return { id: a.id, at: a.at, kind: a.kind, page: a.page, points: a.points, claim: a.claim, version: a.version, state, outcomes: outcomes.map((r) => r.kind), feedback }
  })
  return { summary, items }
}

function shared(opts) {
  const view = sharedView()
  if (opts.json) console.log(JSON.stringify(view, null, 2))
  else for (const line of view.lines) console.log(line)
  return 0
}

function advice(root, opts) {
  if (opts.shared) return shared(opts)
  const { summary, items } = listAdvice(root, opts)
  if (opts.json) {
    console.log(JSON.stringify({ root, summary, advice: items }, null, 2))
    return 0
  }
  if (items.length === 0) {
    console.log(`no advice recorded for ${root}`)
    return 0
  }
  console.log(`advice for ${root}`)
  for (const it of items) {
    const seen = [it.state ?? 'no outcome yet', ...it.feedback.slice(-1).map((v) => `feedback ${v}`)]
    const state = seen.join(', ')
    const where = it.page ?? '-'
    const pts = it.points == null ? '-' : `${it.points} pts`
    console.log(`${it.id} ${it.kind.padEnd(6)} ${where} ${pts} ${state} ${it.claim ?? ''}`.trimEnd())
  }
  const f = summary.feedback
  const bad = summary.badRate == null ? '-' : `${Math.round(summary.badRate * 100)}%`
  console.log(`${summary.issued} issued, ${summary.followed} followed, ${summary.undone} undone, ${summary.misled} misled, ${summary.stale} stale, feedback ${f.wrong} wrong ${f.undone} undone ${f.right} right, ${bad} bad`)
  return 0
}

function feedback(root, opts) {
  if (!VERDICTS.includes(opts.verdict)) {
    console.error('--verdict must be wrong, undone or right')
    return 2
  }
  if (!opts.claim) {
    console.error('--claim is required')
    return 2
  }
  if (opts.advice && !readRows(adviceFile()).some((r) => r.type === 'advice' && r.id === opts.advice && isOf(root)(r))) {
    console.error(`no advice ${opts.advice} for this root`)
    return 2
  }
  const id = newId()
  const row = {
    type: 'feedback',
    id,
    at: new Date().toISOString(),
    adviceId: opts.advice,
    verdict: opts.verdict,
    claim: opts.claim,
    page: opts.page,
    why: opts.why,
    by: opts.by,
    root,
  }
  appendRow(adviceFile(), row)
  lessonFromFeedback(row, opts.advice ? readRows(adviceFile()).find((r) => r.type === 'advice' && r.id === opts.advice) : undefined)
  console.log(`recorded feedback ${id} (${opts.verdict})${opts.advice ? ` on advice ${opts.advice}` : ''}`)
  return 0
}

export async function run(argv) {
  const cmd = argv[0]
  let opts
  try {
    opts = parse(argv)
  } catch (err) {
    console.error(err.message)
    return 2
  }
  const root = path.resolve(opts.root ?? process.cwd())
  return cmd === 'advice' ? advice(root, opts) : feedback(root, opts)
}

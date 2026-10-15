// pricecheck/lib/static/cli.mjs - scan, page, diff, check, freeze: the static measurer's commands. run(argv) -> exit code.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, topFiles } from '../model.mjs'
import { loadConfig } from '../config.mjs'
import { loadBaseline, saveBaseline, compare, freeze, loadViews } from '../ledger.mjs'
import { priceRepo, measurePage, session, discoverFor, pricePages, reachingPages } from './measure.mjs'
import { isPageFile, TEMPLATE_EXT } from './discover.mjs'

const USAGE = `usage: pricecheck <scan|page|diff|check|freeze> [--root <repo>] [options]
  scan [--json] [--limit N]        every page, most expensive first (by daily exposure when views exist)
  page <file>                      one page and the file each point comes from
  diff [--against <ref|baseline>] [--files a,b] [--json]
                                   pages whose price changed: vs the baseline (default), or vs a git ref
  check                            exit 1 on an unreasoned rise, an unfrozen page, a stale entry or an over-budget page
  freeze [--reason "<why>"]        write .pricecheck/baseline.json`

function parse(argv) {
  const opts = { root: process.cwd() }
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--verbose') opts.verbose = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[++i]
      if (val === undefined || val.startsWith('--')) throw new Error(`pricecheck: --${key} needs a value`)
      opts[key] = val
    } else pos.push(a)
  }
  opts.root = path.resolve(opts.root)
  opts.pos = pos
  return opts
}

const posix = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '')
const relOf = (root, f) => posix(path.relative(root, path.resolve(root, f)))
const round = (n) => Math.round(n * 10) / 10
const signed = (n) => `${n > 0 ? '+' : ''}${n}`

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Each file's text at ref, fetched in one `git cat-file --batch` call; null where the file did not exist there. */
function textsAt(root, ref, files) {
  const texts = new Map()
  if (!files.length) return texts
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: `${files.map((f) => `${ref}:./${f}`).join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let at = 0
  for (const f of files) {
    const nl = out.indexOf(10, at)
    const header = out.toString('utf8', at, nl).split(' ')
    at = nl + 1
    if (header.length !== 3 || header[1] !== 'blob') {
      texts.set(f, null)
      continue
    }
    const size = Number(header[2])
    texts.set(f, out.toString('utf8', at, at + size))
    at += size + 1
  }
  return texts
}

/** Files as they were at ref: the markup files changed since ref come from git in one call, every other file from disk. */
function gitShow(root, ref) {
  const old = textsAt(root, ref, changedFiles(root, ref).filter((f) => TEMPLATE_EXT.test(f)))
  const read = (file) => {
    if (old.has(file)) return old.get(file)
    try {
      return fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      return null
    }
  }
  return { read, differs: old }
}

function changedFiles(root, ref) {
  const tracked = git(root, ['diff', '--name-only', '--relative', ref]).split('\n').filter(Boolean)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
  return [...new Set([...tracked, ...untracked].map(posix))]
}

function unitDelta(a = {}, b = {}) {
  const out = {}
  for (const u of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[u] ?? 0) - (a[u] ?? 0)
    if (d) out[u] = d
  }
  return out
}

function fileDeltas(before, after) {
  if (before?.byFile === null) return []
  const files = new Set([...Object.keys(before?.byFile ?? {}), ...Object.keys(after?.byFile ?? {})])
  const out = []
  for (const f of files) {
    const delta = round((after?.byFile[f]?.points ?? 0) - (before?.byFile[f]?.points ?? 0))
    if (delta) out.push({ file: f, delta, units: unitDelta(before?.byFile[f]?.units, after?.byFile[f]?.units) })
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.file.localeCompare(b.file))
}

function changes(opts) {
  const t0 = performance.now()
  const against = opts.against ?? 'baseline'
  const ctx = session(opts.root)
  const pages = discoverFor(ctx)
  const byFile = new Map(pages.map((p) => [p.file, p]))
  const scoped = Boolean(opts.files) || against !== 'baseline'

  let candidates
  if (scoped) {
    const changed = new Set(opts.files ? opts.files.split(',').map((f) => relOf(opts.root, f)) : changedFiles(opts.root, against))
    const gone = [...changed].filter((f) => !byFile.has(f) && isPageFile(f))
    candidates = [...new Set([...reachingPages(ctx, pages, changed), ...gone])]
  } else {
    candidates = [...new Set([...pages.map((p) => p.file), ...Object.keys(loadBaseline(opts.root).pages)])]
  }

  const after = new Map(
    pricePages(
      ctx,
      candidates.map((f) => ({ file: f, route: byFile.get(f)?.route })),
    )
      .filter((p) => !p.missing)
      .map((p) => [p.file, p]),
  )

  let beforeOf
  if (against === 'baseline') {
    const base = loadBaseline(opts.root).pages
    beforeOf = (f) => (base[f] ? { points: base[f].points, byFile: null } : null)
  } else {
    const { read, differs } = gitShow(opts.root, against)
    const hctx = session(opts.root, read)
    // A file unchanged since the ref parses the same: reuse the working tree's parse.
    for (const [f, t] of ctx.templates) if (!differs.has(f)) hctx.templates.set(f, t)
    const before = new Map(
      pricePages(
        hctx,
        candidates.map((f) => ({ file: f })),
      ).map((p) => [p.file, p]),
    )
    beforeOf = (f) => (before.get(f)?.missing ? null : (before.get(f) ?? null))
  }

  const changed = []
  for (const f of candidates) {
    const b = beforeOf(f)
    const a = after.get(f) ?? null
    const delta = round((a?.points ?? 0) - (b?.points ?? 0))
    if (delta === 0 && Boolean(b) === Boolean(a)) continue
    changed.push({ page: f, before: b?.points ?? null, after: a?.points ?? null, delta, files: fileDeltas(b, a) })
  }
  changed.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.page.localeCompare(y.page))
  return { against, changed, ms: Math.round(performance.now() - t0) }
}

function diff(opts) {
  const r = changes(opts)
  if (opts.json) {
    const out = { root: opts.root, mode: 'static', against: r.against, changed: r.changed }
    if (opts.files) out.ms = r.ms
    console.log(JSON.stringify(out, null, 2))
    return 0
  }
  if (!r.changed.length) console.log('no page price changed')
  for (const c of r.changed) {
    const from = c.before ?? 'new'
    const to = c.after ?? 'removed'
    const parts = c.files.map(
      (f) => `${Object.entries(f.units).map(([u, n]) => `${signed(n)} ${u}${Math.abs(n) === 1 ? '' : 's'}`).join(', ') || signed(f.delta) + ' points'} from ${f.file}`,
    )
    console.log(`${c.page} ${from} -> ${to} (${signed(c.delta)}${parts.length ? `: ${parts.join('; ')}` : ''})`)
  }
  if (opts.files) console.log(`checked ${r.changed.length} changed of ${r.against === 'baseline' ? 'the baseline' : r.against} in ${r.ms} ms`)
  return 0
}

/** A priced row as the JSON readers (MCP tool, history, next-page picker) take it: named by `page`. */
const named = (p) => ({ page: p.file, ...p })

function scan(opts) {
  let pages = priceRepo({ root: opts.root }).pages
  const views = loadViews(opts.root)
  if (views) {
    pages = pages
      .map((p) => ({ ...p, views: views[p.file] ?? 0, exposure: p.points * (views[p.file] ?? 0) }))
      .sort((a, b) => b.exposure - a.exposure || b.points - a.points)
  }
  const limit = opts.limit ? Number(opts.limit) : pages.length
  const shown = pages.slice(0, limit)
  if (opts.json) {
    console.log(JSON.stringify({ root: opts.root, mode: 'static', pages: shown.map(named) }, null, 2))
    return 0
  }
  console.log(`${'rank'.padStart(4)}  ${'points'.padStart(7)}${views ? `  ${'exposure'.padStart(10)}` : ''}  page  top file`)
  shown.forEach((p, i) => {
    const top = topFiles(p, 1)[0]?.file ?? ''
    console.log(`${String(i + 1).padStart(4)}  ${String(p.points).padStart(7)}${views ? `  ${String(p.exposure).padStart(10)}` : ''}  ${p.file}  ${top}`)
  })
  console.log(`${pages.length} pages`)
  return 0
}

function page(opts, file) {
  if (!file) throw new Error('pricecheck: page needs a file')
  const rel = relOf(opts.root, file)
  const p = measurePage(opts.root, rel)
  if (opts.json) {
    console.log(JSON.stringify(named(p), null, 2))
    return 0
  }
  console.log(`${rel}: ${describe(p, loadConfig(opts.root).list)}`)
  for (const f of topFiles(p, 50)) console.log(`  ${String(f.points).padStart(7)}  ${f.file}`)
  return 0
}

function check(opts) {
  const cfg = loadConfig(opts.root)
  const current = priceRepo({ root: opts.root }).pages
  const failures = compare(current, loadBaseline(opts.root), cfg)
  if (!failures.length) {
    console.log(`${current.length} pages, all within the ratchet`)
    return 0
  }
  for (const f of failures) {
    if (f.kind === 'rose') console.log(`rose    ${f.file}: ${f.from} -> ${f.to} (needs raisedTo and reason, via freeze --reason)`)
    else if (f.kind === 'unfrozen') console.log(`unfrozen ${f.file}: ${f.points} (run freeze)`)
    else if (f.kind === 'stale') console.log(`stale   ${f.file}: no longer a page (run freeze)`)
    else console.log(`budget  ${f.file}: ${f.points} over ${f.budget}`)
  }
  return 1
}

function freezeCmd(opts) {
  const current = priceRepo({ root: opts.root }).pages
  const pages = freeze(current, loadBaseline(opts.root), opts.reason)
  saveBaseline(opts.root, pages)
  console.log(`froze ${Object.keys(pages).length} pages in .pricecheck/baseline.json`)
  return 0
}

export async function run(argv) {
  const [cmd, ...rest] = argv
  try {
    const opts = parse(rest)
    switch (cmd) {
      case 'scan':
        return scan(opts)
      case 'page':
        return page(opts, opts.pos[0])
      case 'diff':
        return diff(opts)
      case 'check':
        return check(opts)
      case 'freeze':
        return freezeCmd(opts)
      default:
        console.error(USAGE)
        return 2
    }
  } catch (e) {
    console.error(e.message)
    return 2
  }
}

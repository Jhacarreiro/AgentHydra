// pricecheck/lib/static/cli.mjs - scan, page, diff, check, freeze: the static measurer's commands. run(argv) -> exit code.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, topFiles, PRICE_LIST_VERSION } from '../model.mjs'
import { loadConfig } from '../config.mjs'
import { loadBaseline, saveBaseline, compare, freeze, loadViews, priceListChanged } from '../ledger.mjs'
import { priceRepo, measurePage, session, discoverFor, pricePages, reachingPages, reachOver } from './measure.mjs'
import { isPageFile, TEMPLATE_EXT, untrackedOf } from './discover.mjs'
import { recordAdvices } from '../advice/log.mjs'
import { reconcile } from '../advice/reconcile.mjs'
import { progress, readHistory, recordScan } from '../history.mjs'
import { nextTrim } from '../next.mjs'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'pricecheck.mjs')

const USAGE = `usage: pricecheck <scan|page|diff|check|freeze|next> [--root <repo>] [options]
  scan [--json] [--limit N]        every page, most expensive first (by daily exposure when views exist)
  scan [--by app] [--json]         per app instead: total points, pages and dearest page of each app folder
  page <file> [--tree] [--depth N] [--min P]
                                   one page and the file each point comes from; --tree adds what each
                                   rendered component costs (dearest first, components under P points left out)
  diff [--against <ref|baseline>] [--files a,b] [--json] [--budget-ms N]
                                   pages whose price changed: vs the baseline (default), or vs a git ref
  check                            exit 1 on an unreasoned rise, an unfrozen page, a stale entry or an over-budget page
  freeze [--reason "<why>"]        write .pricecheck/baseline.json
  next [--json]                    the page or shared file to trim next, with a brief a worker can run as it is`

function parse(argv) {
  const opts = { root: process.cwd() }
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--tree') opts.tree = true
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
  const untracked = untrackedOf(root) ?? git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
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
  // The budget counts from the start of the process (node's clock), so the hook's wall time ends near it.
  const budget = opts['budget-ms'] === undefined ? null : Number(opts['budget-ms'])
  if (budget !== null && !(budget >= 0)) throw new Error('pricecheck: --budget-ms needs a number of milliseconds')
  const ctx = session(opts.root)
  const pages = discoverFor(ctx)
  const byFile = new Map(pages.map((p) => [p.file, p]))
  const scoped = Boolean(opts.files) || against !== 'baseline'
  const shown = against === 'baseline' ? null : gitShow(opts.root, against)

  let candidates
  if (scoped) {
    const changed = new Set(opts.files ? opts.files.split(',').map((f) => relOf(opts.root, f)) : changedFiles(opts.root, against))
    const gone = [...changed].filter((f) => !byFile.has(f) && isPageFile(f))
    candidates = [...new Set([...reachingPages(ctx, pages, changed), ...gone])]
    // A page that renders none of the markup files that differ from the ref reads the same on both sides, so its delta is zero: `--full` prices it anyway.
    if (shown && opts.full === undefined) {
      const moved = new Set(reachingPages(ctx, candidates.map((file) => ({ file })), new Set(shown.differs.keys())))
      candidates = candidates.filter((f) => moved.has(f) || gone.includes(f))
    }
  } else {
    candidates = [...new Set([...pages.map((p) => p.file), ...Object.keys(loadBaseline(opts.root).pages)])]
  }

  const rows = candidates.map((f) => ({ file: f, route: byFile.get(f)?.route }))
  const reach = reachOver(ctx, rows)
  const after = new Map()
  const before = new Map()
  const hctx = shown && session(opts.root, shown.read, { share: ctx })
  const priceSome = (list) => {
    for (const p of pricePages(ctx, list, reach)) if (!p.missing) after.set(p.file, p)
    // A file unchanged since the ref parses the same: reuse the working tree's parse. Render counts come from the working tree too, so the before side never recounts the repo.
    if (hctx) for (const [f, t] of ctx.templates) if (!shown.differs.has(f)) hctx.templates.set(f, t)
    if (hctx) for (const p of pricePages(hctx, list.map((r) => ({ file: r.file })), reach)) before.set(p.file, p)
  }

  let done = rows
  if (budget === null) priceSome(rows)
  else {
    done = []
    for (const r of rows) {
      if (performance.now() >= budget) break
      priceSome([r])
      done.push(r)
    }
  }

  let beforeOf
  if (against === 'baseline') {
    const base = loadBaseline(opts.root).pages
    beforeOf = (f) => (base[f] ? { points: base[f].points, byFile: null } : null)
  } else beforeOf = (f) => (before.get(f)?.missing ? null : (before.get(f) ?? null))

  const changed = []
  for (const { file: f } of done) {
    const b = beforeOf(f)
    const a = after.get(f) ?? null
    const delta = round((a?.points ?? 0) - (b?.points ?? 0))
    if (delta === 0 && Boolean(b) === Boolean(a)) continue
    changed.push({ page: f, before: b?.points ?? null, after: a?.points ?? null, delta, files: fileDeltas(b, a) })
  }
  changed.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.page.localeCompare(y.page))
  const out = { against, changed, ms: Math.round(performance.now() - t0) }
  if (done.length < rows.length) out.partial = { priced: done.length, of: rows.length }
  return out
}

function diff(opts) {
  const r = changes(opts)
  recordAdvices(
    r.changed
      .filter((c) => c.after !== null)
      .map((c) => ({
        kind: 'diff',
        root: opts.root,
        page: c.page,
        points: c.after,
        files: c.files.map((f) => ({ file: f.file, points: f.delta })),
        claim: `${c.page} ${c.before ?? 'new'} -> ${c.after} (${signed(c.delta)})`,
      })),
  )
  if (opts.json) {
    const out = { root: opts.root, mode: 'static', against: r.against, changed: r.changed }
    if (opts.files) out.ms = r.ms
    if (r.partial) out.partial = r.partial
    console.log(JSON.stringify(out, null, 2))
    return 0
  }
  if (!r.changed.length) console.log(r.partial ? 'no page price changed in the pages priced' : 'no page price changed')
  for (const c of r.changed) {
    const from = c.before ?? 'new'
    const to = c.after ?? 'removed'
    const parts = c.files.map(
      (f) => `${Object.entries(f.units).map(([u, n]) => `${signed(n)} ${u}${Math.abs(n) === 1 ? '' : 's'}`).join(', ') || signed(f.delta) + ' points'} from ${f.file}`,
    )
    console.log(`${c.page} ${from} -> ${to} (${signed(c.delta)}${parts.length ? `: ${parts.join('; ')}` : ''})`)
  }
  if (r.partial) console.log(`partial: priced ${r.partial.priced} of ${r.partial.of} pages before the ${opts['budget-ms']} ms budget ran out`)
  if (opts.files) console.log(`checked ${r.changed.length} changed of ${r.against === 'baseline' ? 'the baseline' : r.against} in ${r.ms} ms`)
  return 0
}

/** A priced row as the JSON readers (MCP tool, history, next-page picker) take it: named by `page`. */
const named = (p) => ({ page: p.file, ...p })

function appOf(root, file, cache) {
  let dir = path.posix.dirname(file)
  const walked = []
  let app = '.'
  for (;;) {
    if (cache.has(dir)) {
      app = cache.get(dir)
      break
    }
    walked.push(dir)
    if (fs.existsSync(path.join(root, dir, 'package.json'))) {
      app = dir
      break
    }
    if (dir === '.') break
    dir = path.posix.dirname(dir)
  }
  for (const d of walked) cache.set(d, app)
  return app
}

function appRollup(root, pages) {
  const cache = new Map()
  const apps = new Map()
  for (const p of pages) {
    const app = appOf(root, p.file, cache)
    const a = apps.get(app) ?? { app, points: 0, pages: 0, top: p.file, topPoints: -Infinity }
    a.points += p.points
    a.pages += 1
    if (p.points > a.topPoints) {
      a.top = p.file
      a.topPoints = p.points
    }
    apps.set(app, a)
  }
  return [...apps.values()]
    .map(({ app, points, pages, top }) => ({ app, points: round(points), pages, top }))
    .sort((a, b) => b.points - a.points || (a.app < b.app ? -1 : a.app > b.app ? 1 : 0))
}

function keepHistory(root, pages) {
  try {
    recordScan({ root, mode: 'static', pages: pages.map(named) })
    reconcile(root)
  } catch {
    return
  }
}

function scan(opts) {
  if (opts.by !== undefined && opts.by !== 'app') throw new Error('pricecheck: --by takes app')
  let pages = priceRepo({ root: opts.root }).pages
  const views = loadViews(opts.root)
  if (views) {
    pages = pages
      .map((p) => ({ ...p, views: views[p.file] ?? 0, exposure: p.points * (views[p.file] ?? 0) }))
      .sort((a, b) => b.exposure - a.exposure || b.points - a.points)
  }
  const limit = opts.limit ? Number(opts.limit) : pages.length
  const shown = pages.slice(0, limit)
  const apps = opts.by === 'app' ? appRollup(opts.root, pages) : null
  keepHistory(opts.root, pages)
  if (opts.json) {
    const body = { root: opts.root, mode: 'static', pages: shown.map(named) }
    if (apps) body.apps = apps
    console.log(JSON.stringify(body, null, 2))
    return 0
  }
  if (apps) {
    for (const a of apps) console.log(`${String(a.points).padStart(7)} points  ${a.pages} pages  ${a.app}  top ${a.top}`)
    console.log(`${apps.length} apps, ${pages.length} pages`)
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

const TREE_WIDTH = 12

function treeLabel(n) {
  if (n.kind === 'branch') return `branch ${n.picked} of ${n.of} at ${n.at}:${n.line}`
  return `<${n.tag}> ${n.file}${n.when ? ` (${n.when})` : ''}`
}

/** The render tree as lines, dearest first: at most TREE_WIDTH children a level, the rest summed on one line. */
function treeLines(node, { min, depth }, indent = 0, out = []) {
  const kids = node.children.filter((k) => k.points > 0).sort((a, b) => b.points - a.points)
  const shown = kids.filter((k) => k.points >= min).slice(0, TREE_WIDTH)
  const pad = '  '.repeat(indent)
  for (const k of shown) {
    out.push(`${String(k.points).padStart(7)}  ${pad}${treeLabel(k)}`)
    if (indent + 1 < depth) treeLines(k, { min, depth }, indent + 1, out)
  }
  const rest = kids.filter((k) => !shown.includes(k))
  if (rest.length) out.push(`${String(round(rest.reduce((s, k) => s + k.points, 0))).padStart(7)}  ${pad}... ${rest.length} more`)
  return out
}

function page(opts, file) {
  if (!file) throw new Error('pricecheck: page needs a file')
  const rel = relOf(opts.root, file)
  const p = measurePage(opts.root, rel, undefined, { trace: opts.tree })
  const lines = () => treeLines(p.tree, { min: opts.min ? Number(opts.min) : Math.max(1, p.points / 100), depth: opts.depth ? Number(opts.depth) : 8 })
  if (opts.json) {
    console.log(JSON.stringify(opts.tree ? { ...named(p), treeLines: lines() } : named(p), null, 2))
    return 0
  }
  console.log(`${rel}: ${describe(p, loadConfig(opts.root).list)}`)
  if (opts.tree) {
    console.log('render tree (each line counts everything inside it):')
    for (const line of lines()) console.log(line)
    return 0
  }
  for (const f of topFiles(p, 50)) console.log(`  ${String(f.points).padStart(7)}  ${f.file}`)
  return 0
}

function check(opts) {
  const cfg = loadConfig(opts.root)
  const baseline = loadBaseline(opts.root)
  const current = priceRepo({ root: opts.root }).pages
  const failures = compare(current, baseline, cfg)
  const list = priceListChanged(baseline) ? { from: baseline.priceList ?? 1, to: PRICE_LIST_VERSION } : undefined
  if (failures.length) {
    recordAdvices(
      failures.map((f) => ({
        kind: 'check',
        root: opts.root,
        page: f.file,
        points: f.kind === 'rose' ? f.to : f.kind === 'stale' ? undefined : f.points,
        claim: `${f.kind} ${f.file}`,
      })),
    )
  }
  if (opts.json) {
    console.log(JSON.stringify({ pages: current.length, failures, ...(list && { priceListChanged: list }) }, null, 2))
    return failures.length ? 1 : 0
  }
  if (list) console.log(`price list changed since the baseline (v${list.from} -> v${list.to}): run pricecheck freeze --reason "price list changed"`)
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

function nextCmd(opts) {
  const priced = priceRepo({ root: opts.root }).pages
  const views = loadViews(opts.root)
  const pages = views
    ? priced.map((p) => ({ ...p, views: views[p.file] ?? 0, exposure: p.points * (views[p.file] ?? 0) }))
    : priced
  keepHistory(opts.root, pages)
  const pick = nextTrim({ root: opts.root, mode: 'static', pages: pages.map(named) }, readHistory(opts.root), {
    cli: `"${process.execPath}" "${BIN}"`,
  })
  if (pick) {
    recordAdvices([
      {
        id: pick.adviceId,
        kind: 'next',
        root: opts.root,
        page: pick.page,
        points: pick.points,
        files: pick.topFiles.map((f) => ({ file: f.file, points: f.points })),
        claim: pick.claim,
      },
    ])
  }
  const prog = progress(opts.root)
  if (opts.json) {
    console.log(JSON.stringify({ root: opts.root, next: pick, progress: prog }, null, 2))
    return 0
  }
  if (!pick) {
    console.log('nothing left to trim: every page is free, or was cut in the last 7 days and has not moved since')
  } else {
    console.log(pick.brief)
  }
  if (prog) {
    const since = prog.listChanged
      ? `the price list changed (v${prog.list}, ${prog.first.at.slice(0, 10)})`
      : `the first snapshot (${prog.first.at.slice(0, 10)})`
    console.log(`progress since ${since}: ${prog.first.total} -> ${prog.now.total} points`)
  }
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
      case 'next':
        return nextCmd(opts)
      default:
        console.error(USAGE)
        return 2
    }
  } catch (e) {
    console.error(e.message)
    return 2
  }
}

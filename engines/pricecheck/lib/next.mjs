// pricecheck/lib/next.mjs - what to trim next (a page, or a file that several pages share) and the brief a worker can run as it is.
import { describe as describePage, topFiles } from './model.mjs'
import { newId } from './advice/log.mjs'

const WEEK_MS = 7 * 24 * 3600 * 1000
const SAME_PRICE = 0.05
const round = (n) => Math.round(n * 10) / 10

/** True when the page was cut within the last week and its price has not moved since that cut. */
function trimmedRecently(page, history, points, now) {
  let cutAt = null
  let cutTo = null
  let prev = null
  for (const snap of history) {
    const p = snap.pages.find((x) => x.page === page)
    if (!p) continue
    if (prev !== null && p.points < prev) {
      cutAt = snap.at
      cutTo = p.points
    }
    prev = p.points
  }
  if (cutAt === null) return false
  return now - Date.parse(cutAt) <= WEEK_MS && Math.abs(points - cutTo) < SAME_PRICE
}

/**
 * Every file on the pages, summed over the pages it is on: points, exposure (each page's points weighted by its views,
 * or by 1 when the scan has no views) and the off-page part of both. Each file lists the pages it costs on.
 */
function sharedFiles(pages, weight) {
  const files = new Map()
  for (const p of pages) {
    const w = weight(p)
    for (const [file, v] of Object.entries(p.byFile ?? {})) {
      if (!(v.points > 0)) continue
      const f = files.get(file) ?? { file, points: 0, exposure: 0, offPoints: 0, offExposure: 0, units: {}, uses: 0, counted: true, pages: [] }
      const off = p.offByFile?.[file] ?? 0
      f.points += v.points
      f.exposure += v.points * w
      f.offPoints += off
      f.uses += v.uses ?? 1
      if (v.uses === undefined) f.counted = false
      f.offExposure += off * w
      for (const [unit, n] of Object.entries(v.units ?? {})) f.units[unit] = (f.units[unit] ?? 0) + n
      f.pages.push({ page: p.page, route: p.route ?? null, points: v.points, exposure: v.points * w, offPoints: off })
      files.set(file, f)
    }
  }
  return [...files.values()]
}

const byRank = (a, b) =>
  b.value - a.value ||
  b.offValue - a.offValue ||
  (a.kind === b.kind ? 0 : a.kind === 'page' ? -1 : 1) ||
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)

/**
 * The thing to trim next, a page or a shared file: the largest by exposure (points times the page's views) when the scan
 * has exposure, else by points. A file's cost is its points summed over every page it is on. Ties go to the one with more
 * off-page points, then to the page. Pages with no points and pages cut in the last week whose price has not moved since
 * are passed over. Null when nothing is left to trim. The caller records the pick as advice under adviceId.
 */
export function nextTrim(scan, history = [], { now = Date.now(), cli = 'pricecheck', adviceId = newId() } = {}) {
  const pages = (scan.pages ?? []).filter((p) => p.points > 0)
  const byExposure = pages.some((p) => typeof p.exposure === 'number')
  const weight = (p) => (byExposure ? (p.views ?? 0) : 1)
  const pageCandidates = pages
    .filter((p) => !trimmedRecently(p.page, history, p.points, now))
    .map((p) => ({
      kind: 'page',
      file: p.page,
      value: byExposure ? (p.exposure ?? 0) : p.points,
      offValue: (p.offPoints ?? 0) * weight(p),
      page: p,
    }))
  const fileCandidates = sharedFiles(pages, weight).map((f) => ({
    kind: 'file',
    file: f.file,
    value: byExposure ? f.exposure : f.points,
    offValue: f.offExposure,
    shared: f,
  }))
  const pick = [...pageCandidates, ...fileCandidates].sort(byRank)[0]
  if (!pick) return null
  const opts = { byExposure, cli, adviceId }
  return pick.kind === 'page' ? pagePick(scan.root, pick.page, opts) : filePick(scan.root, pick.shared, opts)
}

function pagePick(root, page, { byExposure, cli, adviceId }) {
  const all = topFiles(page, Infinity)
  return {
    page: page.page,
    route: page.route ?? null,
    points: page.points,
    exposure: byExposure ? (page.exposure ?? 0) : null,
    describe: describePage(page),
    topFiles: all.slice(0, 5),
    candidate: { kind: 'page', file: page.page, points: page.points, offPoints: page.offPoints ?? 0 },
    adviceId,
    claim: `trim ${page.page} from ${page.points} points`,
    brief: pageBrief(root, page, all, cli, adviceId),
  }
}

function filePick(root, f, { byExposure, cli, adviceId }) {
  const pages = [...f.pages].sort((a, b) => b.exposure - a.exposure || b.points - a.points || (a.page < b.page ? -1 : 1))
  const fileShare = { file: f.file, points: round(f.points), units: f.units, uses: f.uses }
  return {
    page: null,
    route: null,
    points: round(f.points),
    exposure: byExposure ? round(f.exposure) : null,
    describe: `${round(f.points)} points on ${f.pages.length} pages, ${round(f.offPoints)} of them off-page`,
    topFiles: [fileShare],
    candidate: {
      kind: 'file',
      file: f.file,
      points: round(f.points),
      offPoints: round(f.offPoints),
      uses: f.uses,
      pages: pages.map((p) => ({
        page: p.page,
        route: p.route,
        points: round(p.points),
        exposure: byExposure ? round(p.exposure) : null,
        offPoints: round(p.offPoints),
      })),
    },
    adviceId,
    claim: `trim ${f.file} from ${round(f.points)} points across ${f.pages.length} pages`,
    brief: fileBrief(root, f, pages, cli, adviceId),
  }
}

const EXPLAIN = [
  'Price check puts a price on what a page costs the person looking at it: every word, control, field, section,',
  'media item and push toward another product counts, and each point is traced to the file that put it there.',
  'Content about something else (a push toward another product, say) costs three times what content about the page costs.',
]

const feedbackLines = (cli, root, adviceId, pageArg) => [
  `If this advice was wrong (it cannot be cut this way), say so: ${cli} feedback --verdict wrong --advice ${adviceId}${pageArg} --claim "<what was wrong>" --root "${root}"`,
  `If you cut it and then undid the cut, say so: ${cli} feedback --verdict undone --advice ${adviceId}${pageArg} --claim "<what was undone and why>" --root "${root}"`,
]

const PROOF = [
  'Proof for your report: the before and after price lines from that command, and a screenshot of the page before',
  'and after your change.',
]

function pageBrief(root, page, files, cli, adviceId) {
  const share = (points) => (page.points ? Math.round((points / page.points) * 1000) / 10 : 0)
  const offOf = (file) => page.offByFile?.[file] ?? 0
  const offLines = files.filter((f) => offOf(f.file) > 0).map((f) => `- ${f.file}: ${round(offOf(f.file))} off-page points (of its ${f.points} points here)`)
  const fileLines = files.length
    ? files.map((f) => `- ${f.file}: ${f.points} points (${share(f.points)}% of the page)`)
    : ['- (no file can be named for these points)']
  const route = page.route ? ` (route ${page.route})` : ''
  return [
    `You are cutting the price of one page in the web app at "${root}".`,
    '',
    ...EXPLAIN,
    '',
    `The page: ${page.page}${route}`,
    `Its price: ${describePage(page)}`,
    'Off-page content, cut this first:',
    ...(offLines.length ? offLines : ['- (no off-page content on this page)']),
    'Where the points come from:',
    ...fileLines,
    '',
    'Goal, in this order:',
    '1. Cut the off-page content above first.',
    '2. Everything on the page still costs, so cut what can be cheaper. Prefer removing over restyling, and reuse the repo\'s own components.',
    '3. Keep an expensive thing only when it cannot be done cheaper, and keep what the page is for.',
    'Do not make other pages cheaper by moving this page\'s content into them.',
    '',
    `Measure with: ${cli} page ${page.page} --root "${root}"`,
    `Done when: that command shows a price below ${page.points} points, and after \`${cli} freeze --root "${root}"\`,`,
    `\`${cli} check --root "${root}"\` passes.`,
    ...PROOF,
    '',
    ...feedbackLines(cli, root, adviceId, ` --page ${page.page}`),
  ].join('\n')
}

const plural = (unit, n) => (n === 1 || unit === 'media' ? unit : `${unit}s`)

function unitsPerUse(units, uses) {
  const parts = Object.keys(units)
    .sort()
    .map((unit) => ({ unit, n: round(units[unit] / uses) }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${plural(x.unit, x.n)}`)
  return parts.length ? parts.join(' + ') : 'no units counted'
}

function fileBrief(root, f, pages, cli, adviceId) {
  const uses = f.uses
  const top = pages.slice(0, 5)
  const offPages = pages.filter((p) => p.offPoints > 0)
  const dearest = top[0]
  const where = (p) => `${p.page}${p.route ? ` (route ${p.route})` : ''}`
  return [
    `You are cutting the price of one shared file in the web app at "${root}".`,
    '',
    ...EXPLAIN,
    '',
    `The shared file: ${f.file}`,
    `Its price: ${round(f.points)} points on ${pages.length} pages, ${round(f.offPoints)} of them off-page`,
    `What one use costs: about ${round(f.points / uses)} points, ${unitsPerUse(f.units, uses)}`,
    f.counted
      ? `Its uses: ${uses} on ${pages.length} pages`
      : `Its uses: ${uses} on ${pages.length} pages (this scan counts one use per page, so a use costs at most the figure above)`,
    '',
    '(a) Off-page content, cut this first, on the page it belongs to:',
    ...(offPages.length
      ? offPages.map((p) => `- ${where(p)}: ${round(p.offPoints)} off-page points from this file, content about something else; the cut belongs on that page, not in the shared file`)
      : ['- (no off-page content in this file)']),
    '(b) Otherwise, lower what one use costs only where the person loses nothing they need: never remove an accessible name, a label a screen reader needs, or a control the person uses.',
    'If a use cannot be made cheaper without losing something, remove uses on the pages where it costs most:',
    'The five pages it costs most on, dearest first:',
    ...top.map((p) => `- ${where(p)}: ${round(p.points)} points from this file`),
    '',
    'Goal, in this order:',
    '1. Cut the off-page content on each page named in (a), not in the shared file.',
    '2. Otherwise lower what one use costs, only where the person loses nothing they need. Prefer removing over restyling, and reuse the repo\'s own components.',
    '3. Where a use cannot be made cheaper, remove uses on the pages where it costs most, the five above first.',
    'A change to a shared file must keep every page that uses it working: each page in the list must still render and',
    'still do what it is for.',
    '',
    `Measure with: ${cli} page ${dearest.page} --root "${root}"`,
    `Done when: that command shows this file's points below ${round(dearest.points)} on ${dearest.page}, the same holds on`,
    `the other pages above, and after \`${cli} freeze --root "${root}"\`, \`${cli} check --root "${root}"\` passes.`,
    ...PROOF,
    '',
    ...feedbackLines(cli, root, adviceId, ''),
  ].join('\n')
}

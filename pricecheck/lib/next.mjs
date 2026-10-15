// pricecheck/lib/next.mjs - which page to trim next, and the brief a worker can run as it is.
import { describe as describePage, topFiles } from './model.mjs'

const WEEK_MS = 7 * 24 * 3600 * 1000
const SAME_PRICE = 0.05

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
 * The page to trim next: highest exposure when the scan has exposure, else highest points; pages with no points and
 * pages cut in the last week whose price has not moved since are passed over. Null when nothing is left to trim.
 */
export function nextTrim(scan, history = [], { now = Date.now(), cli = 'pricecheck' } = {}) {
  const pages = (scan.pages ?? []).filter((p) => p.points > 0)
  const byExposure = pages.some((p) => typeof p.exposure === 'number')
  const rank = (p) => (byExposure ? (p.exposure ?? 0) : p.points)
  const ranked = [...pages].sort((a, b) => rank(b) - rank(a) || (a.page < b.page ? -1 : 1))
  const pick = ranked.find((p) => !trimmedRecently(p.page, history, p.points, now))
  if (!pick) return null
  const topFilesOf = topFiles(pick)
  return {
    page: pick.page,
    route: pick.route ?? null,
    points: pick.points,
    exposure: pick.exposure ?? null,
    describe: describePage(pick),
    topFiles: topFilesOf,
    brief: brief(scan.root, pick, topFilesOf, cli),
  }
}

function brief(root, page, files, cli) {
  const share = (points) => (page.points ? Math.round((points / page.points) * 1000) / 10 : 0)
  const fileLines = files.length
    ? files.map((f) => `- ${f.file}: ${f.points} points (${share(f.points)}% of the page)`)
    : ['- (no file can be named for these points)']
  const route = page.route ? ` (route ${page.route})` : ''
  return [
    `You are cutting the price of one page in the web app at "${root}".`,
    '',
    'Price check puts a price on what a page costs the person looking at it: every word, control, field, section,',
    'media item and push toward another product counts, and each point is traced to the file that put it there.',
    '',
    `The page: ${page.page}${route}`,
    `Its price: ${describePage(page)}`,
    'Where the points come from:',
    ...fileLines,
    '',
    'Goal: cut this page\'s price as far as you can without losing what the page is for. Every word, control and',
    'section must earn its cost. Prefer removing over restyling, and reuse the repo\'s own components. Do not make',
    'other pages cheaper by moving this page\'s content into them.',
    '',
    `Measure with: ${cli} page ${page.page} --root "${root}"`,
    `Done when: that command shows a price below ${page.points} points, and after \`${cli} freeze --root "${root}"\`,`,
    `\`${cli} check --root "${root}"\` passes.`,
    'Proof for your report: the before and after price lines from that command, and a screenshot of the page before',
    'and after your change.',
  ].join('\n')
}

// pricecheck/lib/ledger.mjs - the ratchet: .pricecheck/baseline.json freezes each page's price; a page may get cheaper any
// time, and dearer only with a written reason (raisedTo + reason). .pricecheck/views.json weights prices by traffic.
import fs from 'node:fs'
import path from 'node:path'
import { globToRe } from './static/discover.mjs'
import { PRICE_LIST_VERSION } from './model.mjs'

const VERSION = 1
const baselinePath = (root) => path.join(root, '.pricecheck', 'baseline.json')
const viewsPath = (root) => path.join(root, '.pricecheck', 'views.json')

export function loadBaseline(root) {
  const file = baselinePath(root)
  if (!fs.existsSync(file)) return null
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (data.version !== VERSION || typeof data.pages !== 'object') throw new Error(`pricecheck: ${file} is not a version ${VERSION} baseline`)
  return data
}

export function saveBaseline(root, pages) {
  const file = baselinePath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ version: VERSION, priceList: PRICE_LIST_VERSION, pages }, null, 2)}\n`)
}

/** A baseline made under an older price list (or before the list was recorded) prices pages on a different scale. */
export const priceListChanged = (baseline) => baseline != null && baseline.priceList !== PRICE_LIST_VERSION

/** Compares current prices with the baseline: [{ kind, file, ... }]. An empty list passes. */
export function compare(current, baseline, cfg = {}) {
  const failures = []
  const budgets = Object.entries(cfg.budgets ?? {}).map(([glob, max]) => ({ re: globToRe(glob), max }))
  const changed = priceListChanged(baseline)
  const seen = new Set()
  for (const page of current) {
    seen.add(page.file)
    const entry = baseline?.pages[page.file]
    if (!entry) failures.push({ kind: 'unfrozen', file: page.file, points: page.points })
    else if (!changed && page.points > entry.points) {
      const reasoned = entry.raisedTo !== undefined && entry.reason && page.points <= entry.raisedTo
      if (!reasoned) failures.push({ kind: 'rose', file: page.file, from: entry.points, to: page.points })
    }
    for (const b of budgets) {
      if (b.re.test(page.file) && page.points > b.max) failures.push({ kind: 'over-budget', file: page.file, points: page.points, budget: b.max })
    }
  }
  if (!changed) for (const file of Object.keys(baseline?.pages ?? {})) if (!seen.has(file)) failures.push({ kind: 'stale', file })
  return failures
}

/** The baseline a freeze writes: each page takes the lower of its frozen and current price; a rise is kept only with a reason. */
export function freeze(current, baseline, reason) {
  const pages = {}
  const changed = priceListChanged(baseline)
  for (const page of current) {
    const old = baseline?.pages[page.file]
    if (!old || changed) pages[page.file] = { points: page.points, units: page.units }
    else if (page.points <= old.points) pages[page.file] = { ...old, points: page.points, units: page.units }
    else if (reason) pages[page.file] = { points: page.points, units: page.units, raisedTo: page.points, reason }
    else pages[page.file] = old
  }
  return pages
}

export function loadViews(root) {
  const file = viewsPath(root)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export { baselinePath, viewsPath }

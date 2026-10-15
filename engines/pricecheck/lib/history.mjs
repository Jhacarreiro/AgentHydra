// pricecheck/lib/history.mjs - the append-only price history, one line per scan that changed a repo's prices, kept forever.
// The file lives outside every repo: <PRICECHECK_HOME or ~/.agenthydra/pricecheck>/history.jsonl.
import fs from 'node:fs'
import path from 'node:path'
import { appendRow, gitHead, homeDir, pricecheckVersion } from './advice/log.mjs'
import { PRICE_LIST_VERSION } from './model.mjs'

export function historyFile() {
  return path.join(homeDir(), 'history.jsonl')
}

const round = (n) => Math.round(n * 10) / 10

/** A scan as one history line: every page's points and units, the sum of the pages' points, and the pricecheck version, price list and git HEAD that priced it. */
export function snapshotOf(scan, at = new Date().toISOString()) {
  const root = path.resolve(scan.root)
  const pages = (scan.pages ?? [])
    .map((p) => ({ page: p.page, points: p.points, units: { ...(p.units ?? {}) } }))
    .sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))
  const total = round(pages.reduce((sum, p) => sum + p.points, 0))
  return { at, root, repo: path.basename(root), mode: scan.mode, total, pages, version: pricecheckVersion(), priceList: PRICE_LIST_VERSION, head: gitHead(root) }
}

const listOf = (snap) => snap.priceList ?? 1

const shapeOf = (snap) => JSON.stringify({ total: snap.total, pages: snap.pages, version: snap.version, priceList: listOf(snap) })

/** Appends the scan unless it is identical to this repo's last snapshot under the same pricecheck version. Returns { written, snapshot }. */
export function recordScan(scan, at) {
  const snapshot = snapshotOf(scan, at)
  const last = readHistory(scan.root).at(-1)
  if (last && shapeOf(last) === shapeOf(snapshot)) return { written: false, snapshot: last }
  appendRow(historyFile(), snapshot)
  return { written: true, snapshot }
}

/** This repo's snapshots, oldest first. A line that does not parse is skipped, not fatal. */
export function readHistory(root) {
  const want = path.resolve(root)
  let text
  try {
    text = fs.readFileSync(historyFile(), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let snap
    try {
      snap = JSON.parse(line)
    } catch {
      continue
    }
    if (snap.root === want) out.push(snap)
  }
  return out
}

/**
 * Progress since this repo's first snapshot under the current price list, which is the only kind that compares cuts
 * (a list change moves prices without anyone cutting). listChanged says older-list snapshots came before it. Null with fewer than two.
 */
export function progress(root) {
  const all = readHistory(root)
  const snaps = all.filter((s) => listOf(s) === PRICE_LIST_VERSION)
  if (snaps.length < 2) return null
  const first = snaps[0]
  const now = snaps.at(-1)
  const before = new Map(first.pages.map((p) => [p.page, p]))
  const drops = []
  const unitsFell = {}
  for (const p of now.pages) {
    const f = before.get(p.page)
    if (!f) continue
    if (f.points > p.points) drops.push({ page: p.page, from: f.points, to: p.points })
    for (const [unit, n] of Object.entries(f.units)) {
      const fell = n - (p.units?.[unit] ?? 0)
      if (fell > 0) unitsFell[unit] = (unitsFell[unit] ?? 0) + fell
    }
  }
  drops.sort((a, b) => b.from - b.to - (a.from - a.to))
  return {
    list: PRICE_LIST_VERSION,
    listChanged: listOf(all[0]) !== PRICE_LIST_VERSION,
    first: { at: first.at, total: first.total },
    now: { at: now.at, total: now.total },
    dropped: round(first.total - now.total),
    pagesCheaper: drops.length,
    biggestDrops: drops.slice(0, 5),
    unitsFell,
  }
}

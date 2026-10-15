// pricecheck/lib/history.mjs - the append-only price history, one line per scan that changed a repo's prices, kept forever.
// The file lives outside every repo: <PRICECHECK_HOME or ~/.agenthydra/pricecheck>/history.jsonl.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function historyFile() {
  const home = process.env.PRICECHECK_HOME || path.join(os.homedir(), '.agenthydra', 'pricecheck')
  return path.join(home, 'history.jsonl')
}

const round = (n) => Math.round(n * 10) / 10

/** A scan as one history line: every page's points and units, and the sum of the pages' points. */
export function snapshotOf(scan, at = new Date().toISOString()) {
  const root = path.resolve(scan.root)
  const pages = (scan.pages ?? [])
    .map((p) => ({ page: p.page, points: p.points, units: { ...(p.units ?? {}) } }))
    .sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))
  const total = round(pages.reduce((sum, p) => sum + p.points, 0))
  return { at, root, repo: path.basename(root), mode: scan.mode, total, pages }
}

const shapeOf = (snap) => JSON.stringify({ total: snap.total, pages: snap.pages })

/** Appends the scan unless it is identical to this repo's last snapshot. Returns { written, snapshot }. */
export function recordScan(scan, at) {
  const snapshot = snapshotOf(scan, at)
  const last = readHistory(scan.root).at(-1)
  if (last && shapeOf(last) === shapeOf(snapshot)) return { written: false, snapshot: last }
  const file = historyFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`)
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

/** Progress since this repo's first snapshot; null when there is no history yet. */
export function progress(root) {
  const snaps = readHistory(root)
  if (!snaps.length) return null
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
    first: { at: first.at, total: first.total },
    now: { at: now.at, total: now.total },
    dropped: round(first.total - now.total),
    pagesCheaper: drops.length,
    biggestDrops: drops.slice(0, 5),
    unitsFell,
  }
}

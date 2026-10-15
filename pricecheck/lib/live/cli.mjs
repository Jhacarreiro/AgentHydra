import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, priceList, rollup, topFiles } from '../model.mjs'
import { measureUrl } from './cdp.mjs'

const USAGE = 'usage: pricecheck live <url> [--cdp <endpoint>] [--json]'

export function parseArgs(argv) {
  const opts = { url: null, cdp: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--cdp') {
      opts.cdp = argv[++i]
      if (!opts.cdp) throw new Error('--cdp needs an endpoint (http://host:port or ws://...)')
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (opts.url) throw new Error(`one URL at a time (got ${opts.url} and ${a})`)
    else opts.url = a
  }
  if (!opts.url) throw new Error('give the page URL to price')
  if (!/^https?:\/\//.test(opts.url)) throw new Error(`${opts.url} is not an http(s) URL`)
  return opts
}

export async function readPriceList(root) {
  let text
  try {
    text = await readFile(join(root, '.pricecheck.json'), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return priceList()
    throw err
  }
  return priceList(JSON.parse(text).weights)
}

export function priceReport(url, results, list) {
  const viewports = results.map(({ name, viewport, items, timing }) => {
    const page = rollup(items, list)
    return {
      name,
      width: viewport.width,
      height: viewport.height,
      points: page.points,
      units: page.units,
      byFile: page.byFile,
      timing,
      items,
    }
  })
  return { url, mode: 'live', viewports }
}

export function formatHuman(report, list) {
  const lines = [`live ${report.url}`]
  for (const v of report.viewports) {
    const page = { points: v.points, units: v.units }
    lines.push(`${v.name} ${v.width}x${v.height}: ${describe(page, list)} (ready in ${v.timing.readyMs} ms)`)
    for (const f of topFiles({ byFile: v.byFile }, 5)) lines.push(`  ${f.points.toString().padStart(6)}  ${f.file}`)
  }
  const worst = Math.max(0, ...report.viewports.map((v) => v.points))
  lines.push(`worst: ${worst} points`)
  return lines.join('\n')
}

export async function run(argv) {
  let opts
  try {
    opts = parseArgs(argv.slice(1))
  } catch (err) {
    console.error(`pricecheck live: ${err.message}\n${USAGE}`)
    return 2
  }
  try {
    const list = await readPriceList(process.cwd())
    const results = await measureUrl(opts.url, { cdp: opts.cdp, root: process.cwd() })
    const report = priceReport(opts.url, results, list)
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatHuman(report, list))
    return 0
  } catch (err) {
    console.error(`pricecheck live: ${err.message}`)
    return 1
  }
}

// pricecheck/lib/report-html.mjs - one self-contained HTML page: the totals, the progress, the ranking, and each page's
// price drawn as a bar of its files' shares. No external assets; light and dark follow the viewer's setting.
import { topFiles } from './model.mjs'

const round = (n) => Math.round(n * 10) / 10
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const pct = (part, whole) => (whole ? round((part / whole) * 100) : 0)
const SWATCHES = 6

const STYLE = `
:root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e2de; --track: #ececea;
  --s0: #4f7a9a; --s1: #b07a3c; --s2: #5c8a5a; --s3: #9a5b7a; --s4: #7a6fb0; --s5: #8a8a4f; --s6: #a3a39c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --fg: #ececea; --muted: #9a9a94; --line: #33332f; --track: #2a2a27;
    --s0: #7fa6c4; --s1: #d1a06a; --s2: #86b583; --s3: #c48aa6; --s4: #a79ee0; --s5: #b5b57a; --s6: #6f6f69; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width: 1000px; margin: 0 auto; padding: 32px 20px 56px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 16px; margin: 36px 0 12px; font-weight: 600; }
.muted { color: var(--muted); font-size: 13px; }
.totals { display: flex; gap: 40px; flex-wrap: wrap; margin-top: 18px; }
.totals strong { display: block; font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
code { font: 13px ui-monospace, Consolas, monospace; }
.page { padding: 14px 0; border-bottom: 1px solid var(--line); }
.page h3 { font-size: 15px; margin: 0 0 6px; font-weight: 600; }
.bar { display: flex; height: 12px; border-radius: 3px; overflow: hidden; background: var(--track); }
.bar span { display: block; height: 100%; }
.legend { margin-top: 6px; font-size: 13px; color: var(--muted); }
.legend span { display: inline-block; margin: 0 16px 2px 0; }
.swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
${Array.from({ length: SWATCHES + 1 }, (_, i) => `.s${i} { background: var(--s${i}); }`).join('\n')}
`

const swatch = (i) => `s${Math.min(i, SWATCHES)}`

function bar(page) {
  const files = topFiles(page, Infinity)
  if (!files.length || !page.points) return ''
  const segs = files.map((f, i) => {
    const w = pct(f.points, page.points)
    return `<span class="${swatch(i)}" style="width:${w}%" title="${esc(f.file)}: ${f.points} points"></span>`
  })
  const legend = files
    .map((f, i) => `<span><i class="swatch ${swatch(i)}"></i>${esc(f.file)} ${f.points} (${pct(f.points, page.points)}%)</span>`)
    .join('')
  return `<div class="bar">${segs.join('')}</div><div class="legend">${legend}</div>`
}

function rankingRows(pages) {
  return pages
    .map((p, i) => {
      const top = topFiles(p, 1)[0]
      const topCell = top ? `${esc(top.file)} <span class="muted">${pct(top.points, p.points)}%</span>` : '<span class="muted">none</span>'
      const exposure = typeof p.exposure === 'number' ? round(p.exposure) : '-'
      return `<tr><td class="num">${i + 1}</td><td>${esc(p.page)}</td><td><code>${esc(p.route ?? '')}</code></td>` +
        `<td class="num">${p.points}</td><td class="num">${exposure}</td><td>${topCell}</td></tr>`
    })
    .join('')
}

function progressSection(progress) {
  if (!progress) return '<p class="muted">No earlier snapshot yet: the next scan starts the history.</p>'
  const drops = progress.biggestDrops.length
    ? `<table><tr><th>Page</th><th class="num">From</th><th class="num">To</th></tr>${progress.biggestDrops
        .map((d) => `<tr><td>${esc(d.page)}</td><td class="num">${d.from}</td><td class="num">${d.to}</td></tr>`)
        .join('')}</table>`
    : '<p class="muted">No page has got cheaper yet.</p>'
  const units = Object.entries(progress.unitsFell)
  const fell = units.length
    ? units.map(([u, n]) => `<span>${n} ${esc(u)}${n === 1 ? '' : 's'}</span>`).join('')
    : '<span class="muted">none</span>'
  return `<div class="totals">` +
    `<div><strong>${round(progress.dropped)}</strong><span class="muted">points saved, ${progress.first.total} to ${progress.now.total}</span></div>` +
    `<div><strong>${progress.pagesCheaper}</strong><span class="muted">pages cheaper</span></div>` +
    `</div><div class="legend">Units removed: ${fell}</div>${drops}`
}

/** The whole report as one HTML document. `scan` is the scan --json shape; `progress` is progress(root) or null. */
export function renderReport({ scan, progress = null, now = new Date() }) {
  const pages = scan.pages ?? []
  const total = round(pages.reduce((sum, p) => sum + p.points, 0))
  const repo = scan.root ? String(scan.root).split(/[\\/]/).filter(Boolean).pop() : 'project'
  const top = pages[0]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Price check: ${esc(repo)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Price check: ${esc(repo)}</h1>
<div class="muted">Generated ${esc(now.toISOString())}</div>
<div class="totals">
<div><strong>${total}</strong><span class="muted">points across ${pages.length} pages</span></div>
${top ? `<div><strong>${top.points}</strong><span class="muted">most expensive: ${esc(top.page)}</span></div>` : ''}
</div>

<h2>Progress since the first snapshot</h2>
${progressSection(progress)}

<h2>Ranking</h2>
${pages.length
    ? `<table><tr><th class="num">Rank</th><th>Page</th><th>Route</th><th class="num">Points</th><th class="num">Exposure</th><th>Top file</th></tr>${rankingRows(pages)}</table>`
    : '<p class="muted">No pages were found.</p>'}

<h2>Where each page's points come from</h2>
${pages.map((p) => `<div class="page"><h3>${esc(p.page)} <span class="muted">${p.points} points</span></h3>${bar(p)}</div>`).join('\n')}
</main>
</body>
</html>
`
}

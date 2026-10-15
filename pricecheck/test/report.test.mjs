import { describe as group, expect, test } from 'bun:test'
import { renderReport } from '../lib/report-html.mjs'

const scan = {
  root: 'C:/Users/example/Projects/example-shop',
  mode: 'static',
  pages: [
    {
      page: 'src/views/Landing.vue',
      route: '/start',
      points: 40,
      units: { word: 30, control: 2 },
      exposure: 120,
      byFile: {
        'src/views/Landing.vue': { points: 30, units: { word: 30 } },
        'src/components/Promo<b>.vue': { points: 10, units: { control: 2 } },
      },
    },
    {
      page: 'src/views/Help.vue',
      route: '/help',
      points: 8,
      units: { word: 8 },
      byFile: { 'src/views/Help.vue': { points: 8, units: { word: 8 } } },
    },
  ],
}

const progress = {
  first: { at: '2026-10-01T09:00:00.000Z', total: 60 },
  now: { at: '2026-10-05T09:00:00.000Z', total: 48 },
  dropped: 12,
  pagesCheaper: 1,
  biggestDrops: [{ page: 'src/views/Landing.vue', from: 52, to: 40 }],
  unitsFell: { word: 12 },
}

const now = new Date('2026-10-14T12:00:00.000Z')

group('renderReport', () => {
  test('is one self-contained page: no external asset, light and dark both', () => {
    const html = renderReport({ scan, progress, now })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toMatch(/<link\b|<script\b|src="http|href="http/)
    expect(html).toContain('prefers-color-scheme: dark')
  })

  test('shows the totals, the progress since the first snapshot, and the ranking', () => {
    const html = renderReport({ scan, progress, now })
    expect(html).toContain('<strong>48</strong><span class="muted">points across 2 pages</span>')
    expect(html).toContain('<strong>12</strong><span class="muted">points saved, 60 to 48</span>')
    expect(html).toContain('Landing.vue')
    expect(html).toContain('/start')
    expect(html).toContain('src/views/Landing.vue <span class="muted">75%</span>')
  })

  test('draws each page as a bar of its file shares', () => {
    const html = renderReport({ scan, progress, now })
    expect(html).toContain('style="width:75%" title="src/views/Landing.vue: 30 points"')
    expect(html).toContain('style="width:25%" title="src/components/Promo&lt;b&gt;.vue: 10 points"')
  })

  test('says so when there is no earlier snapshot', () => {
    expect(renderReport({ scan, progress: null, now })).toContain('No earlier snapshot yet')
  })

  test('escapes page names and routes', () => {
    const html = renderReport({
      scan: { root: 'C:/x/example-shop', pages: [{ page: 'a<script>', points: 1, units: {}, byFile: {} }] },
      progress: null,
      now,
    })
    expect(html).not.toContain('<script>a')
    expect(html).toContain('a&lt;script&gt;')
  })
})

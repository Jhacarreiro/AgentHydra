import { describe as group, expect, test } from 'bun:test'
import './home.mjs'
import { nextTrim } from '../lib/next.mjs'

const ROOT = 'C:/Users/me/Projects/example-shop'
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const DAY = 24 * 3600 * 1000

const page = (name, points, extra = {}) => ({ page: name, points, units: { word: points }, byFile: {}, ...extra })
const scan = (pages) => ({ root: ROOT, mode: 'static', pages })
const snap = (at, pages) => ({ at, root: ROOT, repo: 'example-shop', mode: 'static', total: 0, pages })
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString()

group('nextTrim', () => {
  test('picks the page with the most points when the scan has no exposure', () => {
    const next = nextTrim(scan([page('src/views/Help.vue', 12), page('src/views/Landing.vue', 40)]), [], { now: NOW })
    expect(next.page).toBe('src/views/Landing.vue')
    expect(next.points).toBe(40)
    expect(next.exposure).toBeNull()
  })

  test('picks by exposure when the scan has it, even over a cheaper-looking page', () => {
    const next = nextTrim(
      scan([
        page('src/views/Landing.vue', 40, { exposure: 90 }),
        page('src/views/Pricing.vue', 25, { exposure: 300 }),
      ]),
      [],
      { now: NOW },
    )
    expect(next.page).toBe('src/views/Pricing.vue')
    expect(next.exposure).toBe(300)
  })

  test('skips a page cut in the last 7 days whose price has not moved since', () => {
    const history = [
      snap(at(10), [{ page: 'src/views/Landing.vue', points: 40, units: {} }]),
      snap(at(2), [{ page: 'src/views/Landing.vue', points: 30, units: {} }]),
    ]
    const next = nextTrim(scan([page('src/views/Landing.vue', 30), page('src/views/Help.vue', 12)]), history, { now: NOW })
    expect(next.page).toBe('src/views/Help.vue')
  })

  test('offers a page again once its price has moved since the cut', () => {
    const history = [
      snap(at(10), [{ page: 'src/views/Landing.vue', points: 40, units: {} }]),
      snap(at(2), [{ page: 'src/views/Landing.vue', points: 30, units: {} }]),
    ]
    const next = nextTrim(scan([page('src/views/Landing.vue', 34), page('src/views/Help.vue', 12)]), history, { now: NOW })
    expect(next.page).toBe('src/views/Landing.vue')
  })

  test('offers a page whose last cut is older than 7 days', () => {
    const history = [
      snap(at(20), [{ page: 'src/views/Landing.vue', points: 40, units: {} }]),
      snap(at(9), [{ page: 'src/views/Landing.vue', points: 30, units: {} }]),
    ]
    const next = nextTrim(scan([page('src/views/Landing.vue', 30)]), history, { now: NOW })
    expect(next.page).toBe('src/views/Landing.vue')
  })

  test('passes over pages with no points, and returns null when nothing is left', () => {
    expect(nextTrim(scan([page('src/views/Empty.vue', 0)]), [], { now: NOW })).toBeNull()
    expect(nextTrim(scan([]), [], { now: NOW })).toBeNull()
  })

  test('the brief is self-contained: folder, page, price, each file\'s share, the goal, done and proof', () => {
    const next = nextTrim(
      scan([
        page('src/views/Landing.vue', 40, {
          route: '/',
          byFile: {
            'src/views/Landing.vue': { points: 30, units: { word: 30 } },
            'src/components/Footer.vue': { points: 10, units: { word: 10 } },
          },
        }),
      ]),
      [],
      { now: NOW, cli: 'node C:/Tools/pricecheck/bin/pricecheck.mjs' },
    )
    expect(next.route).toBe('/')
    expect(next.describe).toBe('40 points: 40 words')
    expect(next.topFiles.map((f) => f.file)).toEqual(['src/views/Landing.vue', 'src/components/Footer.vue'])
    const b = next.brief
    expect(b).toContain(ROOT)
    expect(b).toContain('src/views/Landing.vue (route /)')
    expect(b).toContain('Its price: 40 points: 40 words')
    expect(b).toContain('src/components/Footer.vue: 10 points (25% of the page)')
    expect(b).toContain('Prefer removing over restyling')
    expect(b).toContain('reuse the repo\'s own components')
    expect(b).toContain('node C:/Tools/pricecheck/bin/pricecheck.mjs page src/views/Landing.vue')
    expect(b).toContain('below 40 points')
    expect(b).toContain('freeze')
    expect(b).toContain('screenshot')
  })

  test('a pick carries an advice id and a claim, and the brief names the id in its two feedback lines', () => {
    const next = nextTrim(scan([page('src/views/Landing.vue', 40)]), [], { now: NOW, cli: 'pricecheck', adviceId: 'abc12345' })
    expect(next.adviceId).toBe('abc12345')
    expect(next.claim).toBe('trim src/views/Landing.vue from 40 points')
    expect(next.brief).toContain(`pricecheck feedback --verdict wrong --advice abc12345 --page src/views/Landing.vue --claim "<what was wrong>" --root "${ROOT}"`)
    expect(next.brief).toContain('pricecheck feedback --verdict undone --advice abc12345 --page src/views/Landing.vue')
    expect(next.brief.trimEnd().endsWith('--root "' + ROOT + '"')).toBe(true)
  })

  test('without an adviceId the pick gets a fresh 8-character one', () => {
    const a = nextTrim(scan([page('src/views/Landing.vue', 40)]), [], { now: NOW })
    const b = nextTrim(scan([page('src/views/Landing.vue', 40)]), [], { now: NOW })
    expect(a.adviceId).toMatch(/^[0-9a-f]{8}$/)
    expect(b.adviceId).not.toBe(a.adviceId)
  })

  test('a shared file whose summed cost beats every page is picked, with its pages', () => {
    const pages = ['A', 'B', 'C', 'D', 'E'].map((x) =>
      page(`src/views/${x}.vue`, 20, {
        byFile: {
          'src/ui/Button.vue': { points: 10, units: { word: 10 } },
          [`src/views/${x}.vue`]: { points: 10, units: { word: 10 } },
        },
      }),
    )
    const next = nextTrim(scan(pages), [], { now: NOW })
    expect(next.candidate).toMatchObject({ kind: 'file', file: 'src/ui/Button.vue', points: 50, offPoints: 0 })
    expect(next.candidate.pages).toHaveLength(5)
    expect(next.page).toBeNull()
    expect(next.points).toBe(50)
  })

  test('a page beats a file when the page is larger', () => {
    const next = nextTrim(
      scan([
        page('src/views/A.vue', 70, { byFile: { 'src/ui/Button.vue': { points: 20, units: {} }, 'src/views/A.vue': { points: 50, units: {} } } }),
        page('src/views/B.vue', 25, { byFile: { 'src/ui/Button.vue': { points: 20, units: {} }, 'src/views/B.vue': { points: 5, units: {} } } }),
        page('src/views/C.vue', 25, { byFile: { 'src/ui/Button.vue': { points: 20, units: {} }, 'src/views/C.vue': { points: 5, units: {} } } }),
      ]),
      [],
      { now: NOW },
    )
    expect(next.candidate.kind).toBe('page')
    expect(next.page).toBe('src/views/A.vue')
  })

  test('off-page points break a tie between equal candidates', () => {
    const next = nextTrim(
      scan([
        page('src/views/Pricing.vue', 30, { byFile: { 'src/views/Pricing.vue': { points: 30, units: {} } } }),
        page('src/views/Landing.vue', 30, {
          offPoints: 10,
          offByFile: { 'src/promo/Banner.vue': 10 },
          byFile: { 'src/views/Landing.vue': { points: 20, units: {} }, 'src/promo/Banner.vue': { points: 10, units: {} } },
        }),
      ]),
      [],
      { now: NOW },
    )
    expect(next.page).toBe('src/views/Landing.vue')
    expect(next.candidate).toMatchObject({ kind: 'page', offPoints: 10 })
  })

  test('views weighting changes a file\'s sum: traffic-weighted files beat a dearer file on dead pages', () => {
    const dead = Array.from({ length: 10 }, (_, i) =>
      page(`src/views/Dead${i}.vue`, 10, { views: 0, exposure: 0, byFile: { 'src/ui/Legacy.vue': { points: 10, units: {} } } }),
    )
    const busy = ['Y1', 'Y2'].map((x) =>
      page(`src/views/${x}.vue`, 40, {
        views: 1000,
        exposure: 40000,
        byFile: { 'src/ui/Pebble.vue': { points: 30, units: {} }, [`src/views/${x}.vue`]: { points: 10, units: {} } },
      }),
    )
    const next = nextTrim(scan([...dead, ...busy]), [], { now: NOW })
    expect(next.candidate).toMatchObject({ kind: 'file', file: 'src/ui/Pebble.vue', points: 60 })
    expect(next.exposure).toBe(60000)
  })

  test('the brief of a page lists its off-page files before the on-page cost lines', () => {
    const next = nextTrim(
      scan([
        page('src/views/Landing.vue', 42, {
          offPoints: 12,
          offByFile: { 'src/promo/MossBanner.vue': 12 },
          byFile: {
            'src/views/Landing.vue': { points: 30, units: {} },
            'src/promo/MossBanner.vue': { points: 12, units: {} },
          },
        }),
      ]),
      [],
      { now: NOW },
    )
    const b = next.brief
    expect(b.indexOf('src/promo/MossBanner.vue: 12 off-page points')).toBeGreaterThan(-1)
    expect(b.indexOf('src/promo/MossBanner.vue: 12 off-page points')).toBeLessThan(b.indexOf('Where the points come from'))
    expect(b.indexOf('Off-page content')).toBeLessThan(b.indexOf('Where the points come from'))
  })

  test('the brief of a file names the file, its off-page share and only the five dearest pages', () => {
    const pages = Array.from({ length: 7 }, (_, i) =>
      page(`src/views/P${i + 1}.vue`, 20 + i, {
        byFile: { 'src/ui/Button.vue': { points: 11 + i, units: {} }, [`src/views/P${i + 1}.vue`]: { points: 9, units: {} } },
        offByFile: i < 2 ? { 'src/ui/Button.vue': 3 } : {},
      }),
    )
    const next = nextTrim(scan(pages), [], { now: NOW, adviceId: 'abc12345' })
    expect(next.candidate.kind).toBe('file')
    expect(next.candidate.pages).toHaveLength(7)
    const b = next.brief
    expect(b).toContain('The shared file: src/ui/Button.vue')
    expect(b).toContain('Its price: 98 points on 7 pages, 6 of them off-page')
    expect(b.indexOf('Off-page content')).toBeLessThan(b.indexOf('The five pages'))
    for (const dear of ['P7', 'P6', 'P5', 'P4', 'P3']) expect(b).toContain(`src/views/${dear}.vue: `)
    const dearest = b.slice(b.indexOf('The five pages'), b.indexOf('Goal, in this order'))
    for (const cheap of ['P1', 'P2']) expect(dearest).not.toContain(`src/views/${cheap}.vue`)
    expect(b).toContain('--advice abc12345')
    expect(b).not.toContain('--page')
  })

  test('a shared file brief states what one use costs, with its units, and its uses on its pages', () => {
    const pages = Array.from({ length: 4 }, (_, i) =>
      page(`src/views/Q${i}.vue`, 3, { byFile: { 'src/ui/Icon.vue': { points: 3, units: { control: 1, word: 2 } } } }),
    )
    const b = nextTrim(scan(pages), [], { now: NOW }).brief
    expect(b).toContain('What one use costs: about 3 points, 1 control + 2 words')
    expect(b).toContain('Its uses: 4 on 4 pages')
    expect(b).toContain('one use per page')
  })

  test('the per-use line divides by real uses, and says uses and pages', () => {
    const pages = [
      page('src/views/Q0.vue', 12, { byFile: { 'src/ui/Zorp.vue': { points: 12, units: { control: 6 }, uses: 6 } } }),
      page('src/views/Q1.vue', 12, { byFile: { 'src/ui/Zorp.vue': { points: 12, units: { control: 6 }, uses: 6 } } }),
    ]
    const next = nextTrim(scan(pages), [], { now: NOW })
    expect(next.brief).toContain('What one use costs: about 2 points, 1 control')
    expect(next.brief).toContain('Its uses: 12 on 2 pages')
    expect(next.brief).not.toContain('one use per page')
    expect(next.candidate.uses).toBe(12)
  })

  test('a shared file brief names the pages whose off-page content belongs to them, and says that cut belongs on that page', () => {
    const pages = [
      page('src/views/A.vue', 12, { offByFile: { 'src/ui/Icon.vue': 2 }, byFile: { 'src/ui/Icon.vue': { points: 5, units: { control: 1 } }, 'src/views/A.vue': { points: 7, units: { word: 7 } } } }),
      page('src/views/B.vue', 8, { byFile: { 'src/ui/Icon.vue': { points: 5, units: { control: 1 } }, 'src/views/B.vue': { points: 3, units: { word: 3 } } } }),
      page('src/views/C.vue', 8, { byFile: { 'src/ui/Icon.vue': { points: 5, units: { control: 1 } }, 'src/views/C.vue': { points: 3, units: { word: 3 } } } }),
    ]
    const b = nextTrim(scan(pages), [], { now: NOW }).brief
    expect(b).toContain('src/views/A.vue')
    expect(b).toContain('belongs on that page, not in the shared file')
    expect(b.indexOf('belongs on that page')).toBeLessThan(b.indexOf('lower what one use costs'))
    expect(b.indexOf('lower what one use costs')).toBeLessThan(b.indexOf('remove uses on the pages where it costs most'))
  })

  test('a shared file brief never asks a worker to strip an accessible name, a screen reader label or a control the person uses', () => {
    const pages = Array.from({ length: 3 }, (_, i) =>
      page(`src/views/R${i}.vue`, 3, { byFile: { 'src/ui/Icon.vue': { points: 3, units: { control: 1, word: 2 } } } }),
    )
    const b = nextTrim(scan(pages), [], { now: NOW }).brief
    expect(b).toContain('never remove an accessible name')
    expect(b).toContain('a label a screen reader needs')
    expect(b).toContain('a control the person uses')
  })
})

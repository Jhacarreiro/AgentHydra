import { describe as group, expect, test } from 'bun:test'
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
})

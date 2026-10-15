import { beforeAll, describe as group, expect, test } from 'bun:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { priceList } from '../../lib/model.mjs'
import { VIEWPORTS, findBrowser, measureUrl } from '../../lib/live/cdp.mjs'
import { priceReport } from '../../lib/live/cli.mjs'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'live')
const fixture = (name) => pathToFileURL(join(FIXTURES, name)).href
const hasBrowser = findBrowser() !== null
if (!hasBrowser) console.warn('pricecheck live: no Chrome or Edge found, skipping the browser suites')

const total = (result, unit) =>
  result.items.filter((i) => i.unit === unit).reduce((n, i) => n + i.count, 0)
const fileTotal = (result, unit, file) =>
  result.items.filter((i) => i.unit === unit && i.file === file).reduce((n, i) => n + i.count, 0)

// Expected counts for test/fixtures/live/counts.html, worked out by hand from the markup:
//   words 16 (headings, paragraph, 3 links, 2 buttons, 2 labels, "Two", "Card"; hidden text and the select's options excluded)
//   controls 5 (3 links, 2 buttons; the aria-hidden button and the opacity-0 link excluded)
//   fields 3 (text input, textarea, select)   choices 2 (select with 3 options)
//   features 2 (the section and the card, siblings)   media 2 (svg and the visible img)
//   screen 1 (short page)   color 4 (black, red, blue text; white fill)   type 3 (32, 16, 12 px)
//   points 45 = 16 + 10 + 9 + 2 + 6 + 2, with every allowance covering the rest
// motion.html: a looping spinner and an 8 s ticker move on their own; a 2 s entrance slide is part of the page
// opening (its wait), not motion; a hidden spinner is not seen.
group.skipIf(!hasBrowser)('live measure: motion', () => {
  test('only looping or long animations count as motion, not an entrance slide', async () => {
    const [desktop] = await measureUrl(fixture('motion.html'), { root: FIXTURES, viewports: [{ name: 'desktop', width: 1280, height: 800, mobile: false }] })
    expect(total(desktop, 'motion')).toBe(2)
  }, 60000)
})

group.skipIf(!hasBrowser)('live measure: known counts', () => {
  let results
  beforeAll(async () => {
    results = await measureUrl(fixture('counts.html'), { root: FIXTURES })
  }, 60000)

  test('the desktop viewport counts every visible unit and skips hidden ones', () => {
    const [desktop] = results
    expect(desktop.name).toBe('desktop')
    expect(desktop.viewport).toEqual({ width: 1366, height: 900 })
    expect(total(desktop, 'word')).toBe(16)
    expect(total(desktop, 'control')).toBe(5)
    expect(total(desktop, 'field')).toBe(3)
    expect(total(desktop, 'choice')).toBe(2)
    expect(total(desktop, 'feature')).toBe(2)
    expect(total(desktop, 'media')).toBe(2)
    expect(total(desktop, 'screen')).toBe(1)
    expect(total(desktop, 'color')).toBe(4)
    expect(total(desktop, 'type')).toBe(3)
    expect(total(desktop, 'product')).toBe(0)
    expect(total(desktop, 'interruption')).toBe(0)
    expect(total(desktop, 'motion')).toBe(0)
  })

  test('the wait is under the free second on a local fixture', () => {
    expect(total(results[0], 'wait')).toBeLessThanOrEqual(10)
  })

  test('the phone viewport measures the same page at its own size', () => {
    const [, phone] = results
    expect(phone.name).toBe('phone')
    expect(phone.viewport).toEqual({ width: 390, height: 844 })
    expect(total(phone, 'word')).toBe(16)
    expect(total(phone, 'control')).toBe(5)
  })

  test('the price is the weighted count, with allowances taken off', () => {
    const report = priceReport(fixture('counts.html'), results, priceList())
    expect(report.viewports[0].points).toBe(45)
  })

  test('the report has the public shape, with timing per viewport', () => {
    const report = priceReport(fixture('counts.html'), results, priceList())
    expect(Object.keys(report).sort()).toEqual(['mode', 'url', 'viewports'])
    expect(report.mode).toBe('live')
    for (const v of report.viewports) {
      expect(Object.keys(v).sort()).toEqual(['byFile', 'height', 'items', 'name', 'points', 'timing', 'units', 'width'])
      expect(typeof v.timing.readyMs).toBe('number')
    }
  })
})

group.skipIf(!hasBrowser)('live measure: noise is not text', () => {
  test('style, script, noscript, template, head and aria-hidden text count 0 words', async () => {
    const [desktop] = await measureUrl(fixture('noise.html'), { root: FIXTURES, viewports: [VIEWPORTS[0]] })
    expect(total(desktop, 'word')).toBe(3)
  }, 60000)
})

group.skipIf(!hasBrowser)('live measure: a page that shows translations of one message', () => {
  test('words count once, in the page language: 25 in the paragraph plus 2 in the link', async () => {
    const [desktop, phone] = await measureUrl(fixture('example-domain.html'), { root: FIXTURES })
    for (const result of [desktop, phone]) {
      const words = total(result, 'word')
      expect(words).toBeGreaterThanOrEqual(23)
      expect(words).toBeLessThanOrEqual(30)
      expect(words).toBe(27)
    }
  }, 60000)
})

group.skipIf(!hasBrowser)('live measure: component attribution', () => {
  test('Vue 3 host elements name their component file, relative to the root', async () => {
    const [desktop] = await measureUrl(fixture('vue-attribution.html'), { root: '/app', viewports: [{ name: 'desktop', width: 1280, height: 800, mobile: false }] })
    expect(fileTotal(desktop, 'control', 'src/components/Badge.vue')).toBe(1)
    expect(fileTotal(desktop, 'word', 'src/components/Badge.vue')).toBe(2)
    expect(fileTotal(desktop, 'control', 'PriceTag')).toBe(1)
    expect(fileTotal(desktop, 'word', 'PriceTag')).toBe(1)
    expect(fileTotal(desktop, 'word', '(page)')).toBe(1)
  }, 60000)

  test('React fibers name the function component, from its debug source or its name', async () => {
    const [desktop] = await measureUrl(fixture('react-fiber.html'), { root: '/app', viewports: [{ name: 'desktop', width: 1280, height: 800, mobile: false }] })
    expect(fileTotal(desktop, 'control', 'src/ProductCard.jsx')).toBe(1)
    expect(fileTotal(desktop, 'word', 'src/ProductCard.jsx')).toBe(1)
    expect(fileTotal(desktop, 'control', 'LegalFooter')).toBe(1)
    expect(fileTotal(desktop, 'word', 'LegalFooter')).toBe(1)
    expect(fileTotal(desktop, 'interruption', '(page)')).toBe(1)
    expect(fileTotal(desktop, 'control', '(page)')).toBe(1)
  }, 60000)
})

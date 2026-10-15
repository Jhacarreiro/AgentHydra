import { describe, expect, test } from 'bun:test'
import { describe as describePage, priceList, PRICE_LIST_VERSION, rollup } from '../lib/model.mjs'

const word = (count, file, reach = 'own') => ({ unit: 'word', count, file, reach })

describe('rollup reach', () => {
  test('an off item costs three times an own one by default', () => {
    const page = rollup([word(4, 'src/views/A.vue'), word(4, 'src/promo/B.vue', 'off')])
    expect(page.points).toBe(16)
    expect(page.offPoints).toBe(12)
    expect(page.offByFile).toEqual({ 'src/promo/B.vue': 12 })
  })

  test('the off factor can be set per call', () => {
    const page = rollup([word(4, 'src/views/A.vue'), word(4, 'src/promo/B.vue', 'off')], priceList(), { offFactor: 2 })
    expect(page.points).toBe(12)
    expect(page.offPoints).toBe(8)
  })

  test('byFile sums exactly to points with mixed reach', () => {
    const items = [
      word(5, 'src/views/A.vue'),
      { unit: 'control', count: 2, file: 'src/ui/Pebble.vue', reach: 'own' },
      { unit: 'control', count: 3, file: 'src/promo/B.vue', reach: 'off' },
      { unit: 'field', count: 1, file: 'src/promo/B.vue', reach: 'off' },
    ]
    const page = rollup(items)
    expect(Object.values(page.byFile).reduce((s, f) => s + f.points, 0)).toBe(page.points)
    expect(page.points).toBe(5 + 4 + 3 * 2 * 3 + 3 * 3)
    expect(page.offByFile).toEqual({ 'src/promo/B.vue': 27 })
  })

  test('an item with no reach is own', () => {
    expect(rollup([{ unit: 'word', count: 3, file: 'src/views/A.vue' }]).points).toBe(3)
  })

  test('a page with no off items has no off-page points', () => {
    const page = rollup([word(3, 'src/views/A.vue')])
    expect(page.offPoints).toBe(0)
    expect(page.offByFile).toEqual({})
  })
})

describe('describe with off-page points', () => {
  test('names the off-page points when there are any', () => {
    const page = rollup([word(4, 'src/views/A.vue'), word(4, 'src/promo/B.vue', 'off')])
    expect(describePage({ ...page, page: 'A' })).toBe('16 points: 8 words, 12 points off-page')
  })

  test('adds nothing when no item is off-page', () => {
    expect(describePage(rollup([word(4, 'src/views/A.vue')]))).toBe('4 points: 4 words')
  })
})

test('the price list version is the one the ratchet compares against', () => {
  expect(PRICE_LIST_VERSION).toBe(2)
})

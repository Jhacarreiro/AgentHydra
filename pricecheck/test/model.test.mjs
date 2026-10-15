import { describe as group, expect, test } from 'bun:test'
import { describe, priceList, rollup, topFiles } from '../lib/model.mjs'

group('rollup', () => {
  test('weights each unit and attributes every point to the file that added it', () => {
    const page = rollup([
      { unit: 'word', count: 10, file: 'Page.vue' },
      { unit: 'control', count: 2, file: 'Footer.vue' },
      { unit: 'word', count: 4, file: 'Footer.vue' },
    ])
    expect(page.points).toBe(18)
    expect(page.units).toEqual({ word: 14, control: 2 })
    expect(page.byFile['Page.vue'].points).toBe(10)
    expect(page.byFile['Footer.vue'].points).toBe(8)
    expect(topFiles(page)[0].file).toBe('Page.vue')
  })

  test('a free allowance comes off the page once, and the file shares still sum to the price', () => {
    const page = rollup([
      { unit: 'type', count: 3, file: 'A.vue' },
      { unit: 'type', count: 3, file: 'B.vue' },
    ])
    expect(page.points).toBe(4)
    expect(page.byFile['A.vue'].points + page.byFile['B.vue'].points).toBe(4)
  })

  test('a repo can reprice a unit, and an unknown unit is refused', () => {
    expect(rollup([{ unit: 'control', count: 3, file: 'x' }], priceList({ control: 1 })).points).toBe(3)
    expect(() => priceList({ vibes: 2 })).toThrow('unknown unit')
    expect(() => rollup([{ unit: 'vibes', count: 1, file: 'x' }])).toThrow('unknown unit')
  })

  test('describe reads as one line', () => {
    const page = rollup([
      { unit: 'word', count: 5, file: 'x' },
      { unit: 'field', count: 1, file: 'x' },
    ])
    expect(describe(page)).toBe('8 points: 5 words, 1 field x3')
  })
})

import { describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compare, freeze, loadBaseline, priceListChanged, saveBaseline } from '../../lib/ledger.mjs'
import { PRICE_LIST_VERSION } from '../../lib/model.mjs'

const page = (file, points) => ({ file, points, units: { word: points } })
const older = (pages) => ({ priceList: PRICE_LIST_VERSION - 1, pages })

group('a baseline from an older price list', () => {
  test('is detected; a baseline with no price list is older, and no baseline is not', () => {
    expect(priceListChanged(older({}))).toBe(true)
    expect(priceListChanged({ pages: {} })).toBe(true)
    expect(priceListChanged({ priceList: PRICE_LIST_VERSION, pages: {} })).toBe(false)
    expect(priceListChanged(null)).toBe(false)
  })

  test('a page dearer under the new price list is not a rise', () => {
    expect(compare([page('a.vue', 9)], older({ 'a.vue': { points: 4 } }))).toEqual([])
  })

  test('a page with no baseline entry is still unfrozen, and nothing else fails', () => {
    expect(compare([page('a.vue', 9), page('b.vue', 3)], older({ 'a.vue': { points: 4 }, 'gone.vue': { points: 2 } }))).toEqual([
      { kind: 'unfrozen', file: 'b.vue', points: 3 },
    ])
  })

  test('the same baseline under the same price list still reports a rise', () => {
    expect(compare([page('a.vue', 9)], { priceList: PRICE_LIST_VERSION, pages: { 'a.vue': { points: 4 } } })).toEqual([
      { kind: 'rose', file: 'a.vue', from: 4, to: 9 },
    ])
  })

  test('freeze re-prices every page at its current price, with no reason needed', () => {
    const pages = freeze([page('a.vue', 9), page('b.vue', 1)], older({ 'a.vue': { points: 4, units: { word: 4 } } }), 'price list changed')
    expect(pages).toEqual({ 'a.vue': { points: 9, units: { word: 9 } }, 'b.vue': { points: 1, units: { word: 1 } } })
  })

  test('a saved baseline records the price list it was made under', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ledger-'))
    saveBaseline(dir, { 'a.vue': { points: 1, units: {} } })
    const loaded = loadBaseline(dir)
    expect(loaded.priceList).toBe(PRICE_LIST_VERSION)
    expect(priceListChanged(loaded)).toBe(false)
  })
})

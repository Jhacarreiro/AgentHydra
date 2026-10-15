import { describe as group, expect, test } from 'bun:test'
import { compare, freeze } from '../../lib/ledger.mjs'
import { PRICE_LIST_VERSION } from '../../lib/model.mjs'

const page = (file, points) => ({ file, points, units: { word: points } })
const base = (pages) => ({ priceList: PRICE_LIST_VERSION, pages })

group('compare', () => {
  test('a page with no baseline entry is unfrozen', () => {
    expect(compare([page('a.vue', 3)], base({}))).toEqual([{ kind: 'unfrozen', file: 'a.vue', points: 3 }])
  })

  test('a rise without a reason is rose', () => {
    expect(compare([page('a.vue', 5)], base({ 'a.vue': { points: 4 } }))).toEqual([{ kind: 'rose', file: 'a.vue', from: 4, to: 5 }])
  })

  test('a rise within raisedTo with a reason passes; beyond it fails', () => {
    const baseline = base({ 'a.vue': { points: 4, raisedTo: 5, reason: 'new section' } })
    expect(compare([page('a.vue', 5)], baseline)).toEqual([])
    expect(compare([page('a.vue', 6)], baseline)).toEqual([{ kind: 'rose', file: 'a.vue', from: 4, to: 6 }])
  })

  test('a cheaper page passes', () => {
    expect(compare([page('a.vue', 2)], base({ 'a.vue': { points: 4 } }))).toEqual([])
  })

  test('a baseline entry with no current page is stale', () => {
    expect(compare([], base({ 'gone.vue': { points: 4 } }))).toEqual([{ kind: 'stale', file: 'gone.vue' }])
  })

  test('a page over its glob budget is over-budget', () => {
    const cfg = { budgets: { 'src/views/**': 3 } }
    const baseline = base({ 'src/views/A.vue': { points: 5 } })
    expect(compare([page('src/views/A.vue', 5)], baseline, cfg)).toEqual([{ kind: 'over-budget', file: 'src/views/A.vue', points: 5, budget: 3 }])
  })
})

group('freeze', () => {
  test('a cheaper page takes its new, lower price', () => {
    expect(freeze([page('a.vue', 3)], base({ 'a.vue': { points: 5 } }))['a.vue'].points).toBe(3)
  })

  test('a rise without a reason keeps the old frozen price', () => {
    expect(freeze([page('a.vue', 7)], base({ 'a.vue': { points: 5 } }))['a.vue'].points).toBe(5)
  })

  test('a rise with a reason is recorded with raisedTo and the reason', () => {
    expect(freeze([page('a.vue', 7)], base({ 'a.vue': { points: 5 } }), 'added a plan table')['a.vue']).toEqual({
      points: 7,
      units: { word: 7 },
      raisedTo: 7,
      reason: 'added a plan table',
    })
  })

  test('a cheaper page keeps the reason it was raised with', () => {
    const old = { points: 7, raisedTo: 7, reason: 'added a plan table' }
    expect(freeze([page('a.vue', 4)], base({ 'a.vue': old }))['a.vue']).toEqual({ points: 4, units: { word: 4 }, raisedTo: 7, reason: 'added a plan table' })
  })

  test('a new page is frozen at its price', () => {
    expect(freeze([page('new.vue', 2)], base({}))['new.vue']).toEqual({ points: 2, units: { word: 2 } })
  })
})

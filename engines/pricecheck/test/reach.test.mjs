import { describe, expect, test } from 'bun:test'
import { featureWords, reachRules } from '../lib/reach.mjs'

const PAGE = 'src/views/OrchidPage.vue'
const rules = (cfg = {}, rendered = new Map(), pages = 0) => reachRules(cfg, rendered, pages)
const item = (unit, file, via) => ({ unit, count: 1, file, via })

describe('featureWords', () => {
  test('splits camelCase and kebab-case, lowercases, drops generic and short words', () => {
    expect([...featureWords('src/components/ZincMarble.vue')].sort()).toEqual(['marble', 'zinc'])
    expect([...featureWords('src/components/zinc-marble.vue')].sort()).toEqual(['marble', 'zinc'])
    expect([...featureWords('src/views/OrchidPage.vue')].sort()).toEqual(['orchid'])
    expect([...featureWords('src/ox/Io.vue')]).toEqual([])
  })

  test('a plural and its singular are one feature word', () => {
    expect([...featureWords('src/views/RentalsView.vue')]).toEqual(['rental'])
    expect(rules().reachOf(item('word', 'src/widgets/RentalSync.vue'), 'src/views/RentalsView.vue')).toBe('own')
  })
})

describe('reach of an item', () => {
  test('the page file itself is own', () => {
    expect(rules().reachOf(item('word', PAGE), PAGE)).toBe('own')
  })

  test('a product push is always off, even on the page file', () => {
    expect(rules().reachOf(item('product', PAGE), PAGE)).toBe('off')
    expect(rules().reachOf(item('product', 'src/views/orchid/Petal.vue'), PAGE)).toBe('off')
  })

  test('a file under the page folder is own', () => {
    expect(rules().reachOf(item('word', 'src/views/Garden.vue'), PAGE)).toBe('own')
    expect(rules().reachOf(item('word', 'src/views/orchid/Petal.vue'), PAGE)).toBe('own')
  })

  test('a file sharing a feature word with the page is own, and camelCase and kebab-case count', () => {
    expect(rules().reachOf(item('word', 'src/components/OrchidCard.vue'), PAGE)).toBe('own')
    expect(rules().reachOf(item('word', 'src/components/orchid-tile.vue'), 'src/views/OrchidPage.vue')).toBe('own')
    expect(rules().reachOf(item('word', 'src/components/ZincMarble.vue'), 'src/views/MarbleTile.vue')).toBe('own')
  })

  test('generic words never match: a shared Card or Page is not a shared feature', () => {
    expect(rules().reachOf(item('word', 'src/components/CardList.vue'), 'src/views/CardPage.vue')).toBe('off')
  })

  test('short words never match', () => {
    expect(rules().reachOf(item('word', 'src/components/OxBar.vue'), 'src/views/OxPage.vue')).toBe('off')
    expect(rules().reachOf(item('word', 'src/components/OxBar.vue'), 'src/views/OxBarPage.vue')).toBe('own')
  })

  test('anything else is off', () => {
    expect(rules().reachOf(item('word', 'src/promo/MossBanner.vue'), PAGE)).toBe('off')
  })

  test('a kit file takes the reach of the nearest non-kit file above it', () => {
    expect(rules().reachOf(item('control', 'src/ui/PebbleButton.vue', PAGE), PAGE)).toBe('own')
    expect(rules().reachOf(item('control', 'src/ui/PebbleButton.vue', 'src/promo/MossBanner.vue'), PAGE)).toBe('off')
  })

  test('a kit item with no file above it is own', () => {
    expect(rules().reachOf(item('control', 'src/ui/PebbleButton.vue'), PAGE)).toBe('own')
  })

  test('an unnamed item (live path, no file) is own', () => {
    expect(rules().reachOf(item('word', '(page)'), PAGE)).toBe('own')
    expect(rules().reachOf(item('word', ''), PAGE)).toBe('own')
  })
})

describe('kit files', () => {
  test('a file under a folder named like a building block is kit; a folder merely containing the word is not', () => {
    const r = rules()
    for (const f of ['src/ui/Pebble.vue', 'src/kit/Pebble.vue', 'src/base/Pebble.vue', 'src/common/Pebble.vue', 'src/shared/Pebble.vue', 'src/primitives/Pebble.vue', 'src/design-system/Pebble.vue', 'src/layout/Pebble.vue', 'src/layouts/Pebble.vue']) {
      expect(r.isKit(f)).toBe(true)
    }
    expect(r.isKit('src/uitools/Pebble.vue')).toBe(false)
    expect(r.isKit('src/views/Pebble.vue')).toBe(false)
  })

  test('a file rendered by at least 20% of the pages (and at least 3) is kit, at the edge included', () => {
    const at = (count, pages) => reachRules({}, new Map([['src/shelves/Tag.vue', count]]), pages).isKit('src/shelves/Tag.vue')
    expect(at(3, 15)).toBe(true)
    expect(at(3, 16)).toBe(false)
    expect(at(2, 10)).toBe(false)
    expect(at(4, 10)).toBe(true)
  })
})

describe('config globs', () => {
  test('reach globs win over the defaults', () => {
    const cfg = { own: ['src/promo/**'], off: ['src/ui/**'], kit: ['src/shelves/**'] }
    const r = rules(cfg)
    expect(r.reachOf(item('word', 'src/promo/MossBanner.vue'), PAGE)).toBe('own')
    expect(r.reachOf(item('control', 'src/ui/PebbleButton.vue', PAGE), PAGE)).toBe('off')
    expect(r.isKit('src/shelves/Tag.vue')).toBe(true)
    expect(r.reachOf(item('word', 'src/shelves/Tag.vue', 'src/feed/Digest.vue'), PAGE)).toBe('off')
  })
})

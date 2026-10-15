import { describe, expect, test } from 'bun:test'
import { featureWords, reachRules } from '../lib/reach.mjs'

const rules = () => reachRules({}, new Map(), 0)
const item = (unit, file, via) => ({ unit, count: 1, file, via })

describe('repo layout words are not feature words', () => {
  test('the services, packages and web folders above a frontend are layout, not a feature', () => {
    expect([...featureWords('services/web/src/App.vue')]).toEqual([])
    expect([...featureWords('packages/web/src/components/Basalt.vue')]).toEqual(['basalt'])
    expect([...featureWords('services/tundra/web/src/views/TundraPage.vue')].sort()).toEqual(['tundra'])
  })

  test('a file in another service does not share a page for being in the same services folder', () => {
    const page = 'services/fernery/web/src/views/OrchidPage.vue'
    expect(rules().reachOf(item('word', 'services/moss/web/src/components/Basalt.vue'), page)).toBe('off')
    expect(rules().reachOf(item('word', 'services/fernery/web/src/components/OrchidCard.vue'), page)).toBe('own')
  })
})

describe('a shared UI library folder is kit by its name', () => {
  const page = 'services/fernery/web/src/views/OrchidPage.vue'
  const ownParent = 'services/fernery/web/src/components/OrchidCard.vue'
  const otherParent = 'services/moss/web/src/components/Basalt.vue'

  test('a folder ending in -ui, -components, -kit, -primitives or -design-system is kit', () => {
    const { isKit } = rules()
    expect(isKit('packages/acme-ui/src/Button.vue')).toBe(true)
    expect(isKit('packages/acme-components/src/table/Table.vue')).toBe(true)
    expect(isKit('packages/acme-kit/src/Tag.vue')).toBe(true)
    expect(isKit('packages/acme-primitives/src/Dot.vue')).toBe(true)
    expect(isKit('packages/acme-design-system/src/Glow.vue')).toBe(true)
  })

  test('a folder that only contains ui in the middle of its name is not kit', () => {
    const { isKit } = rules()
    expect(isKit('packages/quiz-builder/src/Quiz.vue')).toBe(false)
    expect(isKit('services/guide/web/src/Tour.vue')).toBe(false)
  })

  test('a shared UI file takes the reach of the file that rendered it', () => {
    expect(rules().reachOf(item('word', 'packages/acme-ui/src/Button.vue', ownParent), page)).toBe('own')
    expect(rules().reachOf(item('word', 'packages/acme-components/src/table/Table.vue', otherParent), page)).toBe('off')
  })
})

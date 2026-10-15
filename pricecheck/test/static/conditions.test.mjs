import { describe as group, expect, test } from 'bun:test'
import { UNKNOWN, declaredProps, evaluate, literal, propsOf, viewportFlag } from '../../lib/static/conditions.mjs'

const env = (vars) => (path) => (path in vars ? vars[path] : UNKNOWN)

group('evaluate', () => {
  test('known names, negation, && and || in three-valued logic', () => {
    const look = env({ open: true, compact: false })
    expect(evaluate('open', look)).toBe(true)
    expect(evaluate('!compact', look)).toBe(true)
    expect(evaluate('open && compact', look)).toBe(false)
    expect(evaluate('compact && other', look)).toBe(false)
    expect(evaluate('open || other', look)).toBe(true)
    expect(evaluate('other && open', look)).toBe(null)
    expect(evaluate('!(open && !compact)', look)).toBe(false)
  })

  test('comparison against a literal, either side; anything else is unknown', () => {
    const look = env({ variant: 'confirm', count: 3 })
    expect(evaluate("variant === 'confirm'", look)).toBe(true)
    expect(evaluate("'alert' === variant", look)).toBe(false)
    expect(evaluate("variant !== 'confirm'", look)).toBe(false)
    expect(evaluate('count == 3', look)).toBe(true)
    expect(evaluate('count > 2', look)).toBe(null)
    expect(evaluate('items.length', look)).toBe(null)
    expect(evaluate('isOpen(row)', look)).toBe(null)
  })
})

group('literal and propsOf', () => {
  test('literals in attribute values, JSX braces included', () => {
    expect(literal('true')).toBe(true)
    expect(literal('{false}')).toBe(false)
    expect(literal("'sm'")).toBe('sm')
    expect(literal('42')).toBe(42)
    expect(literal('isOpen')).toBe(UNKNOWN)
  })

  test('static attributes are strings, a bare attribute is true, bound names are forwarded when known', () => {
    const props = propsOf(
      { variant: 'confirm', 'is-overlay': true, ':dense': 'false', ':title': 'pageTitle', ':open': 'open', '@close': 'x', class: 'a' },
      (p) => (p === 'open' ? true : UNKNOWN),
    )
    expect(props).toEqual({ variant: 'confirm', isOverlay: true, dense: false, title: UNKNOWN, open: true })
  })
})

group('viewportFlag', () => {
  test('phone and desktop layout names by their last segment', () => {
    expect(viewportFlag('state.isMobileViewport')).toBe('phone')
    expect(viewportFlag('ctx.isMobile')).toBe('phone')
    expect(viewportFlag('display.smAndDown')).toBe('phone')
    expect(viewportFlag('compact')).toBe(null)
    expect(viewportFlag('isNarrowScreen')).toBe('phone')
    expect(viewportFlag('isDesktop')).toBe('desktop')
    expect(viewportFlag('isOpen')).toBe(null)
    expect(viewportFlag('mobileNumber')).toBe(null)
  })
})

group('declaredProps', () => {
  test('vue: type literal props with withDefaults', () => {
    const src = `<script setup lang="ts">
const props = withDefaults(defineProps<{
  title?: string
  showIcon?: boolean
  size?: 'sm' | 'md'
  onPick?: (id: string) => void
}>(), { showIcon: true, size: 'md', items: () => [] })
</script>`
    expect(Object.fromEntries(declaredProps(src, 'A.vue'))).toEqual({ title: undefined, showIcon: true, size: 'md', onPick: undefined })
  })

  test('vue: an in-file interface, a runtime object with Boolean and default, an array', () => {
    expect([...declaredProps('interface Props { label: string; hint?: string }\ndefineProps<Props>()', 'A.vue').keys()]).toEqual(['label', 'hint'])
    const runtime = declaredProps("defineProps({ dense: Boolean, tone: { type: String, default: 'neutral' }, note: String })", 'A.vue')
    expect(Object.fromEntries(runtime)).toEqual({ dense: false, tone: 'neutral', note: undefined })
    expect([...declaredProps("export default { props: ['label', 'is-open'] }", 'A.vue').keys()]).toEqual(['label', 'isOpen'])
  })

  test('react: the destructured first parameter, with defaults', () => {
    const src = 'export default function Card({ title, compact = false, tone = "plain", ...rest }: Props) {\n  return <div />\n}'
    expect(Object.fromEntries(declaredProps(src, 'Card.tsx'))).toEqual({ title: undefined, compact: false, tone: 'plain' })
  })

  test('a file that declares nothing readable gives null', () => {
    expect(declaredProps('<template><p>Hi</p></template>', 'A.vue')).toBe(null)
    expect(declaredProps('defineProps<ImportedProps>()', 'A.vue')).toBe(null)
  })
})

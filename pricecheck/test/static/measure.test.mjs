import { describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverFor, priceRepo, reachingPages, session } from '../../lib/static/measure.mjs'

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
const price = (root, file) => priceRepo({ root, pages: [file] }).pages[0]

function repo(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-measure-'))
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

const sum = (byFile) => Object.values(byFile).reduce((s, f) => s + f.points, 0)

group('vue', () => {
  test('a child component is attributed to its own file, and the shares add up to the page', () => {
    const p = price(fixture('vue'), 'src/views/SignInPage.vue')
    expect(p.points).toBe(48)
    expect(p.byFile['src/components/SignInFooterBar.vue']).toEqual({ points: 9, units: { control: 2, word: 4, media: 1 } })
    expect(sum(p.byFile)).toBe(p.points)
  })

  test('the alias import of a component is followed', () => {
    expect(Object.keys(price(fixture('vue'), 'src/views/SignInPage.vue').byFile)).toContain('src/components/SignInFooterBar.vue')
  })

  test('a v-if/v-else prices only its heavier branch', () => {
    expect(price(fixture('vue'), 'src/views/SignInPage.vue').units.word).toBe(29)
  })

  test('$t resolves its key from the locale catalog', () => {
    const dir = repo({
      'locales/en.json': '{ "signin": { "help": "Need a hand? Read the guide." } }',
      'src/views/Help.vue': '<template><p>{{ $t(\'signin.help\') }}</p></template>',
    })
    expect(price(dir, 'src/views/Help.vue').units.word).toBe(6)
  })

  test('a named import from a plain module is not priced as a component', () => {
    const dir = repo({
      'src/menu.ts': 'export function Items() {\n  return "lots of words in a plain module"\n}\n',
      'src/views/Menu.vue': "<template><p>Menu</p><Items /></template>\n<script setup lang=\"ts\">\nimport { Items } from '../menu'\n</script>\n",
    })
    const p = price(dir, 'src/views/Menu.vue')
    expect(p.points).toBe(1)
    expect(Object.keys(p.byFile)).toEqual(['src/views/Menu.vue'])
  })

  test('a component used without an import is found by its name', () => {
    const dir = repo({
      'src/components/Badge.vue': '<template><span class="badge">New</span></template>',
      'src/views/Home.vue': '<template><main><Badge /></main></template>',
    })
    const p = price(dir, 'src/views/Home.vue')
    expect(p.points).toBe(1)
    expect(p.byFile['src/components/Badge.vue'].points).toBe(1)
  })
})

group('react', () => {
  test('lazy and imported components are followed; a select past its first option is a choice', () => {
    const p = price(fixture('react'), 'src/pages/HomePage.tsx')
    expect(Object.keys(p.byFile)).toEqual(expect.arrayContaining(['src/components/Banner.tsx', 'src/components/Settings.tsx', 'src/pages/FeatureCard.tsx']))
    expect(p.byFile['src/components/Settings.tsx'].units.choice).toBe(2)
  })
})

group('svelte', () => {
  test('a template {#if} takes its heavier branch and an imported component is followed', () => {
    const p = price(fixture('svelte'), 'src/routes/AboutPage.svelte')
    expect(p.units.word).toBe(17)
    expect(p.byFile['src/lib/Team.svelte'].units.feature).toBe(1)
  })
})

group('html', () => {
  test('script and head text are not priced', () => {
    const p = price(fixture('html'), 'index.html')
    expect(p.points).toBe(16)
    expect(p.units.word).toBe(12)
  })
})

group('reverse reach', () => {
  test('a changed component reaches the pages that render it, directly or through other components', () => {
    const ctx = session(fixture('vue'))
    const pages = discoverFor(ctx)
    expect(reachingPages(ctx, pages, new Set(['src/components/SignInFooterBar.vue']))).toEqual(['src/views/SignInPage.vue'])
    expect(reachingPages(ctx, pages, new Set(['src/views/SignInPage.vue']))).toEqual(['src/views/SignInPage.vue'])
    expect(reachingPages(ctx, pages, new Set(['src/unrelated.vue']))).toEqual([])
  })
})

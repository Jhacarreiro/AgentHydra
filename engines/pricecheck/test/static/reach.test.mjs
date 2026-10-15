import { describe as group, expect, test } from 'bun:test'
import '../home.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { priceRepo } from '../../lib/static/measure.mjs'

const PAGE = 'src/views/OrchidPage.vue'

function repo(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reach-'))
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

const sum = (byFile) => Object.values(byFile).reduce((s, f) => s + f.points, 0)

const files = {
  [PAGE]: `<script setup>
import MossBanner from '../promo/MossBanner.vue'
import PebbleButton from '../ui/PebbleButton.vue'
</script>
<template>
  <main>
    <h1>Orchid garden notes</h1>
    <PebbleButton>Save now</PebbleButton>
    <MossBanner><span>Hello there</span></MossBanner>
  </main>
</template>
`,
  'src/promo/MossBanner.vue': `<template>
  <aside><p>Try the big sale</p><slot /></aside>
</template>
`,
  'src/ui/PebbleButton.vue': `<template>
  <button><slot /></button>
</template>
`,
}

group('reach in a page price', () => {
  test('content another feature puts on the page is off; the page keeps its own content and the slot it passed in', () => {
    const p = priceRepo({ root: repo(files), pages: [PAGE] }).pages[0]
    expect(p.byFile['src/promo/MossBanner.vue']).toEqual({ points: 12, units: { word: 4 }, uses: 1 })
    expect(p.offByFile).toEqual({ 'src/promo/MossBanner.vue': 12 })
    expect(p.offPoints).toBe(12)
    expect(p.points).toBe(7 + 12 + 2)
    expect(sum(p.byFile)).toBe(p.points)
  })

  test('a kit component is own where the page renders it and off where an off-page feature renders it', () => {
    const tree = {
      ...files,
      'src/promo/MossBanner.vue': `<template>
  <aside><p>Try the big sale</p><PebbleButton>Close</PebbleButton><slot /></aside>
</template>
<script setup>
import PebbleButton from '../ui/PebbleButton.vue'
</script>
`,
    }
    const p = priceRepo({ root: repo(tree), pages: [PAGE] }).pages[0]
    expect(p.points).toBe(30)
    expect(p.offPoints).toBe(21)
    expect(p.offByFile).toEqual({ 'src/promo/MossBanner.vue': 15, 'src/ui/PebbleButton.vue': 6 })
    expect(p.byFile['src/ui/PebbleButton.vue']).toEqual({ points: 8, units: { control: 2 }, uses: 2 })
    expect(sum(p.byFile)).toBe(p.points)
  })

  test('the off factor comes from .pricecheck.json', () => {
    const p = priceRepo({ root: repo({ ...files, '.pricecheck.json': '{ "reach": { "offFactor": 2 } }' }), pages: [PAGE] }).pages[0]
    expect(p.points).toBe(7 + 8 + 2)
    expect(p.offPoints).toBe(8)
  })

  test('reach globs from .pricecheck.json override the defaults', () => {
    const p = priceRepo({ root: repo({ ...files, '.pricecheck.json': '{ "reach": { "own": ["src/promo/**"] } }' }), pages: [PAGE] }).pages[0]
    expect(p.offPoints).toBe(0)
    expect(p.points).toBe(7 + 4 + 2)
  })

  test('a page with no off-page content has no off-page points', () => {
    const p = priceRepo({ root: repo({ [PAGE]: '<template><main><h1>Orchid garden</h1></main></template>\n' }), pages: [PAGE] }).pages[0]
    expect(p.offPoints).toBe(0)
    expect(p.offByFile).toEqual({})
  })
})

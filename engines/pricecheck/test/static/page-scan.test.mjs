import { describe, expect, test } from 'bun:test'
import '../home.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { measurePage, priceRepo } from '../../lib/static/measure.mjs'

function repo(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-parity-'))
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

const PAGES = Array.from({ length: 15 }, (_, i) => `src/views/Page${i + 1}.vue`)
const WITH_BADGE = new Set(PAGES.slice(0, 3))

const tree = Object.fromEntries(
  PAGES.map((file, i) => [
    file,
    WITH_BADGE.has(file)
      ? `<script setup>\nimport Badge from '../widgets/Badge.vue'\n</script>\n<template>\n  <main><h1>Heading ${i + 1} notes</h1><Badge>Shown here</Badge></main>\n</template>\n`
      : `<template>\n  <main><h1>Heading ${i + 1} notes</h1><p>Quiet text</p></main>\n</template>\n`,
  ]),
)
tree['src/widgets/Badge.vue'] = '<template>\n  <span>Try the big sale <slot /></span>\n</template>\n'

describe('a page prices the same alone as in a scan', () => {
  test('a component kit only by the 20% render rule prices the same in page mode and in scan', () => {
    const root = repo(tree)
    const scanned = priceRepo({ root }).pages.find((p) => p.file === 'src/views/Page1.vue')
    const alone = measurePage(root, 'src/views/Page1.vue')
    expect(scanned.offByFile['src/widgets/Badge.vue']).toBeUndefined()
    expect(alone.points).toBe(scanned.points)
    expect(alone.byFile).toEqual(scanned.byFile)
  })
})

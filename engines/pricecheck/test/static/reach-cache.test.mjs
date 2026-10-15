import { describe, expect, test } from 'bun:test'
import '../home.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { measurePage, priceRepo } from '../../lib/static/measure.mjs'

const PAGES = Array.from({ length: 15 }, (_, i) => `src/views/Page${i + 1}.vue`)

const pageWith = (i, badge) =>
  badge
    ? `<script setup>\nimport Badge from '../widgets/Badge.vue'\n</script>\n<template>\n  <main><h1>Heading ${i + 1} notes</h1><Badge>Shown here</Badge></main>\n</template>\n`
    : `<template>\n  <main><h1>Heading ${i + 1} notes</h1><p>Quiet text</p></main>\n</template>\n`

function repo(renderingBadge) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cache-'))
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  PAGES.forEach((f, i) => write(f, pageWith(i, renderingBadge.has(f))))
  write('src/widgets/Badge.vue', '<template>\n  <span>Try the big sale <slot /></span>\n</template>\n')
  return dir
}

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-home-'))
const cacheFiles = (dir) => fs.readdirSync(path.join(dir, 'reach-cache'))

describe('app-wide render counts are cached and never stale', () => {
  test('the app-wide render counts are reused when nothing changed', () => {
    process.env.PRICECHECK_HOME = home()
    const root = repo(new Set(PAGES.slice(0, 3)))
    const first = priceRepo({ root }).pages.find((p) => p.file === 'src/views/Page1.vue')
    expect(first.offByFile['src/widgets/Badge.vue']).toBeUndefined()
    const [name] = cacheFiles(process.env.PRICECHECK_HOME)
    const file = path.join(process.env.PRICECHECK_HOME, 'reach-cache', name)
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    entry.rendered = []
    fs.writeFileSync(file, JSON.stringify(entry))
    const second = priceRepo({ root }).pages.find((p) => p.file === 'src/views/Page1.vue')
    expect(second.offByFile['src/widgets/Badge.vue']).toBeGreaterThan(0)
  })

  test('editing a template so a component crosses the 20% line changes its reach on the next call', () => {
    process.env.PRICECHECK_HOME = home()
    const root = repo(new Set(PAGES.slice(0, 2)))
    const before = priceRepo({ root }).pages.find((p) => p.file === 'src/views/Page1.vue')
    expect(before.offByFile['src/widgets/Badge.vue']).toBeGreaterThan(0)
    fs.writeFileSync(path.join(root, 'src/views/Page3.vue'), pageWith(2, true))
    const after = priceRepo({ root }).pages.find((p) => p.file === 'src/views/Page1.vue')
    expect(after.offByFile['src/widgets/Badge.vue']).toBeUndefined()
  })

  test('page mode and scan agree on a warm cache', () => {
    process.env.PRICECHECK_HOME = home()
    const root = repo(new Set(PAGES.slice(0, 3)))
    const scanned = priceRepo({ root }).pages.find((p) => p.file === 'src/views/Page1.vue')
    const alone = measurePage(root, 'src/views/Page1.vue')
    const warmScan = priceRepo({ root }).pages.find((p) => p.file === 'src/views/Page1.vue')
    expect(alone.points).toBe(scanned.points)
    expect(warmScan.points).toBe(scanned.points)
    expect(alone.byFile).toEqual(scanned.byFile)
  })

  test('the cache keeps only the newest 64 entries on write', () => {
    process.env.PRICECHECK_HOME = home()
    const dir = path.join(process.env.PRICECHECK_HOME, 'reach-cache')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 70; i++) {
      const f = path.join(dir, `old${String(i).padStart(2, '0')}.json`)
      fs.writeFileSync(f, '{}')
      fs.utimesSync(f, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i))
    }
    priceRepo({ root: repo(new Set(PAGES.slice(0, 3))) })
    const left = cacheFiles(process.env.PRICECHECK_HOME)
    expect(left).toHaveLength(64)
    expect(left).not.toContain('old00.json')
    expect(left).toContain('old69.json')
  })
})

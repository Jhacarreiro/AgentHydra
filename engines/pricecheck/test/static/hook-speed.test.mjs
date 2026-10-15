import { afterAll, beforeAll, describe as group, expect, test } from 'bun:test'
import '../home.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../../lib/static/cli.mjs'

let dir

async function diff(extra) {
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    await run(['diff', '--against', 'HEAD', '--json', '--root', dir, ...extra])
  } finally {
    console.log = log
  }
  const { ms, ...rest } = JSON.parse(lines.join('\n'))
  return rest
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
}
const git = (args) => execFileSync('git', ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', ...args], { cwd: dir, stdio: 'ignore' })
const view = (name, tags) => `<template><main><h1>${name} view</h1>${tags}</main></template>\n<script setup>\nimport AppCard from '../components/AppCard.vue'\nimport SideNote from '../components/SideNote.vue'\n</script>\n`
const CARD = (words) => `<template><section><p>${words}</p><button>Open</button></section></template>\n`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-speed-'))
  put('src/components/AppCard.vue', CARD('Plain card text'))
  put('src/components/SideNote.vue', '<template><aside><p>Side note here</p></aside></template>\n')
  put('src/views/Alpha.vue', view('Alpha', '<AppCard /><AppCard />'))
  put('src/views/Beta.vue', view('Beta', '<AppCard /><SideNote />'))
  put('src/views/Gamma.vue', view('Gamma', '<SideNote />'))
  put('src/views/Delta.vue', view('Delta', '<AppCard />'))
  git(['init', '-q'])
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const reset = () => git(['checkout', '-q', '--', '.'])

group('the fast path prices the same deltas as pricing every page twice', () => {
  test('a shared component edited: fast equals --full, and the pages that use it moved', async () => {
    put('src/components/AppCard.vue', CARD('Plain card text with a good many more words in it now'))
    const fast = await diff(['--files', 'src/components/AppCard.vue'])
    const full = await diff(['--files', 'src/components/AppCard.vue', '--full', 'yes'])
    expect(fast).toEqual(full)
    expect(fast.changed.map((c) => c.page).sort()).toEqual(['src/views/Alpha.vue', 'src/views/Beta.vue', 'src/views/Delta.vue'])
    expect(fast.partial).toBeUndefined()
    reset()
  })

  test('a no-op edit while another file is dirty: fast equals --full, only the dirty file moves pages', async () => {
    put('src/components/SideNote.vue', '<template><aside><p>Side note here and more words</p></aside></template>\n')
    const fast = await diff(['--files', 'src/components/AppCard.vue'])
    const full = await diff(['--files', 'src/components/AppCard.vue', '--full', 'yes'])
    expect(fast).toEqual(full)
    expect(fast.changed.map((c) => c.page)).toEqual(['src/views/Beta.vue'])
    reset()
  })

  test('a no-op edit on a clean tree: nothing changed', async () => {
    const fast = await diff(['--files', 'src/components/AppCard.vue'])
    expect(fast.changed).toEqual([])
    expect(fast).toEqual(await diff(['--files', 'src/components/AppCard.vue', '--full', 'yes']))
  })
})

group('the budget gives a partial answer that says so', () => {
  test('a budget of zero prices no page, invents no price, and says priced 0 of 3', async () => {
    put('src/components/AppCard.vue', CARD('Plain card text with a good many more words in it now'))
    const r = await diff(['--files', 'src/components/AppCard.vue', '--budget-ms', '0'])
    expect(r.changed).toEqual([])
    expect(r.partial).toEqual({ priced: 0, of: 3 })
    reset()
  })

  test('a roomy budget finishes: the full answer, no partial mark', async () => {
    put('src/components/AppCard.vue', CARD('Plain card text with a good many more words in it now'))
    const roomy = await diff(['--files', 'src/components/AppCard.vue', '--budget-ms', '600000'])
    const full = await diff(['--files', 'src/components/AppCard.vue', '--full', 'yes'])
    expect(roomy).toEqual(full)
    reset()
  })
})

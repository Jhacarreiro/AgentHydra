import { afterAll, describe as group, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../lib/static/cli.mjs'

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
const dirs = []

async function capture(argv) {
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    const code = await run(argv)
    return { code, out: lines.join('\n') }
  } finally {
    console.log = log
  }
}

function copyOf(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cli-'))
  dirs.push(dir)
  fs.cpSync(fixture(name), dir, { recursive: true })
  return dir
}

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', ...args], { cwd, stdio: 'ignore' })

const FOOTER_MORE = [
  '<template>',
  '  <footer class="footer-bar">',
  '    <a href="/help">Help</a>',
  '    <a href="https://other-product.example.com/start">Try Other Product</a>',
  '    <span class="icon">*</span>',
  '    <p>Two more</p>',
  '  </footer>',
  '</template>',
  '',
  '<script setup lang="ts">',
  '</script>',
  '',
].join('\n')

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

group('json rows name their page, as the MCP tool, history and next-page picker read it', () => {
  test('scan --json rows and page --json both carry page', async () => {
    const scanned = JSON.parse((await capture(['scan', '--json', '--root', fixture('vue')])).out)
    expect(scanned.pages.map((p) => p.page)).toEqual(['src/views/SignInPage.vue'])
    const { code, out } = await capture(['page', 'src/components/SignInFooterBar.vue', '--json', '--root', fixture('vue')])
    const row = JSON.parse(out)
    expect(code).toBe(0)
    expect(row.page).toBe('src/components/SignInFooterBar.vue')
    expect(row.points).toBeGreaterThan(0)
  })
})

group('scan', () => {
  test('--json gives each page its route when router evidence or the pages folder has one', async () => {
    const { code, out } = await capture(['scan', '--json', '--root', fixture('react')])
    const { pages } = JSON.parse(out)
    expect(code).toBe(0)
    expect(pages.find((p) => p.file === 'src/pages/HomePage.tsx').route).toBe('/HomePage')
    expect(pages.find((p) => p.file === 'src/pages/FeatureCard.tsx').route).toBe('/FeatureCard')
  })

  test('--json leaves route out of a page with no route', async () => {
    const { out } = await capture(['scan', '--json', '--root', fixture('vue')])
    const [page] = JSON.parse(out).pages
    expect(page).not.toHaveProperty('route')
  })
})

group('diff against the baseline', () => {
  test('--files re-prices only the pages that render the file, in the json contract', async () => {
    const dir = copyOf('vue')
    expect((await capture(['freeze', '--root', dir])).code).toBe(0)
    fs.writeFileSync(path.join(dir, 'src/components/SignInFooterBar.vue'), FOOTER_MORE)

    const { code, out } = await capture(['diff', '--files', 'src/components/SignInFooterBar.vue', '--json', '--root', dir])
    const r = JSON.parse(out)
    expect(code).toBe(0)
    expect(Object.keys(r).sort()).toEqual(['against', 'changed', 'mode', 'ms', 'root'])
    expect(r.mode).toBe('static')
    expect(r.against).toBe('baseline')
    expect(typeof r.ms).toBe('number')
    expect(r.changed).toEqual([{ page: 'src/views/SignInPage.vue', before: 48, after: 50, delta: 2, files: [] }])
  })

  test('the human line says how many pages were checked and in how many ms', async () => {
    const dir = copyOf('vue')
    await capture(['freeze', '--root', dir])
    fs.writeFileSync(path.join(dir, 'src/components/SignInFooterBar.vue'), FOOTER_MORE)
    const { out } = await capture(['diff', '--files', 'src/components/SignInFooterBar.vue', '--root', dir])
    expect(out).toMatch(/^src\/views\/SignInPage\.vue 48 -> 50 \(\+2\)\n/)
    expect(out).toMatch(/checked 1 changed of the baseline in \d+ ms$/)
  })
})

group('diff against a git ref', () => {
  test('per-file attribution, new and removed pages, sorted by |delta| then page', async () => {
    const dir = copyOf('vue')
    fs.writeFileSync(path.join(dir, 'src/views/Extra.vue'), '<template><p>Bye now</p></template>\n')
    git(dir, ['init', '-q'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'init'])

    fs.writeFileSync(path.join(dir, 'src/components/SignInFooterBar.vue'), FOOTER_MORE)
    fs.rmSync(path.join(dir, 'src/views/Extra.vue'))
    fs.writeFileSync(path.join(dir, 'src/views/Fresh.vue'), '<template><p>Hi there</p></template>\n')

    const files = 'src/components/SignInFooterBar.vue,src/views/Extra.vue,src/views/Fresh.vue'
    const { out } = await capture(['diff', '--against', 'HEAD', '--files', files, '--json', '--root', dir])
    const r = JSON.parse(out)
    expect(r.against).toBe('HEAD')
    expect(r.changed.map((c) => c.page)).toEqual(['src/views/Extra.vue', 'src/views/Fresh.vue', 'src/views/SignInPage.vue'])
    expect(r.changed[0]).toEqual({
      page: 'src/views/Extra.vue',
      before: 2,
      after: null,
      delta: -2,
      files: [{ file: 'src/views/Extra.vue', delta: -2, units: { word: -2 } }],
    })
    expect(r.changed[1]).toEqual({
      page: 'src/views/Fresh.vue',
      before: null,
      after: 2,
      delta: 2,
      files: [{ file: 'src/views/Fresh.vue', delta: 2, units: { word: 2 } }],
    })
    expect(r.changed[2]).toEqual({
      page: 'src/views/SignInPage.vue',
      before: 48,
      after: 50,
      delta: 2,
      files: [{ file: 'src/components/SignInFooterBar.vue', delta: 2, units: { word: 2 } }],
    })
  })
})

group('page --tree', () => {
  test('prints what each rendered component costs, dearest first, under the v-if chain branch it was priced from', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cli-'))
    dirs.push(dir)
    const files = {
      'src/components/Panel.vue': '<template><section><h2>Three word title</h2><button>Go</button></section></template>',
      'src/components/Small.vue': '<template><p>One</p></template>',
      'src/views/Home.vue': "<template>\n<Small />\n<Panel v-if=\"tab === 'a'\" />\n<Small v-else />\n</template>\n",
    }
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), text)
    }
    const { code, out } = await capture(['page', 'src/views/Home.vue', '--tree', '--root', dir])
    expect(code).toBe(0)
    expect(out.split('\n').slice(1)).toEqual([
      'render tree (each line counts everything inside it):',
      "      9  branch 1 of 2 at src/views/Home.vue:3",
      "      9    <Panel> src/components/Panel.vue (v-if tab === 'a')",
      '      1  <Small> src/components/Small.vue',
    ])
    const json = JSON.parse((await capture(['page', 'src/views/Home.vue', '--tree', '--json', '--root', dir])).out)
    expect(json.tree.children.map((n) => n.points)).toEqual([1, 9])
    expect(json.treeLines).toEqual([
      "      9  branch 1 of 2 at src/views/Home.vue:3",
      "      9    <Panel> src/components/Panel.vue (v-if tab === 'a')",
      '      1  <Small> src/components/Small.vue',
    ])
  })
})

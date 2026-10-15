import { describe as group, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverPages, fileRoute, isPageFile } from '../../lib/static/discover.mjs'

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
const files = (pages) => pages.map((p) => p.file)

function repo(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-discover-'))
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

group('discovery per framework', () => {
  test('vue: views are pages, components are not', () => {
    expect(files(discoverPages(fixture('vue')))).toEqual(['src/views/SignInPage.vue'])
  })

  test('react: pages folder is file-routed, components are not', () => {
    const pages = discoverPages(fixture('react'))
    expect(files(pages)).toEqual(['src/pages/FeatureCard.tsx', 'src/pages/HomePage.tsx'])
    expect(pages.find((p) => p.file === 'src/pages/HomePage.tsx').route).toBe('/HomePage')
  })

  test('svelte: a *Page.svelte is a page, a lib component is not', () => {
    expect(files(discoverPages(fixture('svelte')))).toEqual(['src/routes/AboutPage.svelte'])
  })

  test('html: a document with a body is a page', () => {
    expect(files(discoverPages(fixture('html')))).toEqual(['index.html'])
  })

  test('build output, tmp and dependency folders are never pages', () => {
    const page = '<template><p>Hi</p></template>'
    const root = repo({
      'src/views/Home.vue': page,
      'tmp/views/Old.vue': page,
      'cdk.out/views/Synth.vue': page,
      'dist/pages/Built.html': '<body>built</body>',
      'node_modules/pkg/views/Dep.vue': page,
    })
    expect(files(discoverPages(root))).toEqual(['src/views/Home.vue'])
  })

  test('files the repo gitignores are never pages, even outside the usual build folders', () => {
    const root = repo({
      '.gitignore': 'app/assets/public\n',
      'src/views/Home.vue': '<template><p>Hi</p></template>',
      'app/assets/public/copy.html': '<body>a build copy</body>',
    })
    execFileSync('git', ['init', '-q'], { cwd: root })
    expect(files(discoverPages(root))).toEqual(['src/views/Home.vue'])
  }, 20_000)

  test('test and fixture folders are never pages', () => {
    const root = repo({
      'index.html': '<body>home</body>',
      'test/fixtures/site/index.html': '<body>fixture</body>',
      'tests/e2e/page.html': '<body>harness</body>',
      'pkg/fixtures/views/Fake.vue': '<template><p>fake</p></template>',
    })
    expect(files(discoverPages(root))).toEqual(['index.html'])
  })

  test('router records make their screens pages, with the route', () => {
    const root = repo({
      'src/router.ts': [
        "import { createRouter, createWebHistory } from 'vue-router'",
        "const routes = [{ path: '/pricing', component: () => import('./screens/Plans.vue') }]",
        'export const router = createRouter({ history: createWebHistory(), routes })',
        '',
      ].join('\n'),
      'src/screens/Plans.vue': '<template><p>Plans</p></template>',
    })
    const pages = discoverPages(root, {}, (spec) => (spec === './screens/Plans.vue' ? 'src/screens/Plans.vue' : null))
    expect(pages).toEqual([{ file: 'src/screens/Plans.vue', route: '/pricing' }])
  })

  test('config pages globs replace discovery', () => {
    expect(files(discoverPages(fixture('vue'), { pages: ['src/components/*.vue'] }))).toEqual(['src/components/SignInFooterBar.vue'])
  })

  test('config ignore globs drop pages', () => {
    expect(discoverPages(fixture('vue'), { ignore: ['src/views/**'] })).toEqual([])
  })
})

group('file routes and page names', () => {
  test('fileRoute reads Next app, SvelteKit and pages-folder routes', () => {
    expect(fileRoute('app/(shop)/blog/[slug]/page.tsx')).toBe('/blog/[slug]')
    expect(fileRoute('app/page.tsx')).toBe('/')
    expect(fileRoute('src/routes/docs/+page.svelte')).toBe('/docs')
    expect(fileRoute('pages/_app.tsx')).toBeUndefined()
  })

  test('isPageFile is true for a page name, false for a component or a test', () => {
    expect(isPageFile('src/views/A.vue')).toBe(true)
    expect(isPageFile('src/components/A.vue')).toBe(false)
    expect(isPageFile('src/views/A.test.vue')).toBe(false)
  })
})

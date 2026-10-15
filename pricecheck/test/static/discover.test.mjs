import { describe as group, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverPages, fileRoute, isPageFile } from '../../lib/static/discover.mjs'
import { makeGraph } from '../../lib/static/graph.mjs'

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

  test('a single-screen app: the root component its entry mounts is the page at /, unless it only hosts a router', () => {
    const resolve = (spec, from) => (spec === './App.vue' || spec === './App' ? `${from.split('/')[0]}/${spec === './App' ? 'App.tsx' : 'App.vue'}` : null)
    const root = repo({
      'one/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n",
      'one/App.vue': '<template><p>The whole app</p></template>',
      'two/main.tsx': "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(el).render(<App />)\n",
      'two/App.tsx': 'export default function App() { return <p>Hi</p> }',
      'shell/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n",
      'shell/App.vue': '<template><RouterView /></template>',
    })
    expect(discoverPages(root, {}, resolve)).toEqual([
      { file: 'one/App.vue', route: '/' },
      { file: 'two/App.tsx', route: '/' },
    ])
  })

  test('a page-named component that another template renders is a component, not a page', () => {
    const root = repo({
      'src/components/RowEmptyStateView.vue': '<template><p>Nothing here yet</p></template>',
      'src/components/Table.vue': "<script setup>import RowEmptyStateView from './RowEmptyStateView.vue'</script>\n<template><RowEmptyStateView /></template>",
      'src/views/Home.vue': "<script setup>import Table from '../components/Table.vue'</script>\n<template><Table /></template>",
    })
    const graph = makeGraph(root)
    expect(files(discoverPages(root, {}, graph.resolveFile, graph))).toEqual(['src/views/Home.vue'])
  })

  test('a page-named component rendered through a lazy import() binding is a component', () => {
    const root = repo({
      'src/views/dev/LedgerPanelView.vue': '<template><p>Ledger</p></template>',
      'src/views/Workbench.vue': '<script setup>const Panel = defineAsync(() => import("./dev/LedgerPanelView.vue"))</script>\n<template><Panel v-if="open" /></template>',
    })
    const graph = makeGraph(root)
    expect(files(discoverPages(root, {}, graph.resolveFile, graph))).toEqual(['src/views/Workbench.vue'])
  })

  test('a page-named component nothing renders stays a page', () => {
    const root = repo({ 'src/components/LonelyPage.vue': '<template><p>Lonely</p></template>' })
    const graph = makeGraph(root)
    expect(files(discoverPages(root, {}, graph.resolveFile, graph))).toEqual(['src/components/LonelyPage.vue'])
  })

  test('a router or file-routed page stays a page even when another template renders it', () => {
    const root = repo({
      'src/router.ts': [
        "import { createRouter, createWebHistory } from 'vue-router'",
        "import Plans from './views/Plans.vue'",
        "const routes = [{ path: '/pricing', component: Plans }]",
        'export const router = createRouter({ history: createWebHistory(), routes })',
        '',
      ].join('\n'),
      'src/views/Plans.vue': '<template><p>Plans</p></template>',
      'src/components/Shell.vue': "<script setup>import Plans from '../views/Plans.vue'</script>\n<template><Plans /></template>",
      'app/pricing/page.tsx': 'export default function P() { return <p>Pricing</p> }',
    })
    const graph = makeGraph(root)
    expect(discoverPages(root, {}, graph.resolveFile, graph)).toEqual([
      { file: 'app/pricing/page.tsx', route: '/pricing' },
      { file: 'src/views/Plans.vue', route: '/pricing' },
    ])
  })

  test('the views and pages folder rule does not apply below a components folder', () => {
    const root = repo({
      'src/components/workspace/views/host/HostRowChip.vue': '<template><p>Host</p></template>',
      'src/components/pages/Crumb.vue': '<template><p>Crumb</p></template>',
      'src/views/Bar.vue': '<template><p>Bar</p></template>',
    })
    expect(files(discoverPages(root))).toEqual(['src/views/Bar.vue'])
    expect(isPageFile('src/components/workspace/views/host/HostRowChip.vue')).toBe(false)
    expect(isPageFile('src/views/Bar.vue')).toBe(true)
  })

  test('an html file that is only an app shell is not a page; a static page with content is', () => {
    const root = repo({
      'index.html': '<!doctype html><html><head><script>x()</script></head><body>\n  <div id="app"></div>\n  <noscript>Turn on JavaScript</noscript>\n  <script type="module" src="/src/main.ts"></script>\n</body></html>',
      'about.html': '<body><h1>About us</h1></body>',
      'docs.html': '<body><div id="root"></div><p>Read the docs</p></body>',
      'boot.html': '<body><style>#app:empty { min-height: 100vh }</style><div id="app"></div><!-- note --></body>',
    })
    expect(files(discoverPages(root))).toEqual(['about.html', 'docs.html'])
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

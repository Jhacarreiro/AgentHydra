import { describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverFor, priceFile, priceRepo, reachingPages, session } from '../../lib/static/measure.mjs'

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

  test('a page in one app of a monorepo reads its own app catalog, not a sibling one', () => {
    const dir = repo({
      'services/a/web/src/i18n/messages/en-US/page.ts': 'export const m = { title: "Alpha title words" }',
      'packages/b/src/i18n/messages/en-US/page.ts': 'export const m = { title: "Beta" }',
      'services/a/web/src/views/Home.vue': '<template><p>{{ tr("title") }}</p><i18n-t keypath="title" /></template>',
    })
    expect(price(dir, 'services/a/web/src/views/Home.vue').units.word).toBe(6)
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

  test('what a page passes into a component (its slot) is priced, on the page; a slot fallback only when nothing is passed', () => {
    const dir = repo({
      'src/components/Card.vue': '<template><div class="frame"><slot>Nothing here yet</slot></div></template>',
      'src/views/Home.vue': '<template><Card><h1>Five words in this title</h1><button>Go</button></Card><Card /></template>',
    })
    const p = price(dir, 'src/views/Home.vue')
    expect(p.units).toEqual({ word: 9, control: 1 })
    expect(p.byFile['src/views/Home.vue'].units).toEqual({ word: 6, control: 1 })
    expect(p.byFile['src/components/Card.vue'].units).toEqual({ word: 3 })
  })

  test('an overlay is off screen until it opens: a closed dialog costs nothing, a tooltip costs only its trigger', () => {
    const dir = repo({
      'src/components/AppDialog.vue': '<template><div role="dialog"><button>Close</button><slot /></div></template>',
      'src/components/AppTooltip.vue': '<template><span><slot /><span role="tooltip"><slot name="content" /></span></span></template>',
      'src/views/Home.vue': [
        '<template>',
        '<AppDialog :open="isOpen"><p>Lots of hidden words here now</p></AppDialog>',
        '<AppTooltip><button>Save</button><template #content>Saves your draft right now</template></AppTooltip>',
        '<AppDialog open><p>Shown on arrival</p></AppDialog>',
        '</template>',
      ].join('\n'),
    })
    const p = price(dir, 'src/views/Home.vue')
    expect(p.units).toEqual({ control: 2, word: 5, interruption: 1 })
    expect(p.byFile['src/views/Home.vue'].units).toEqual({ control: 1, word: 4 })
  })

  test('a <component :is> that renders a button or link is a control, and an icon name it prints is media, not a word', () => {
    const dir = repo({
      'src/components/IconButton.vue': `<template><component :is="href ? 'a' : 'button'" :href="href"><span :class="iconClass">{{ icon }}</span></component></template>`,
      'src/views/Home.vue': '<template><IconButton icon="close" /><span>{{ item.leadingIcon }}</span></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ control: 1, media: 2 })
  })

  test('a v-if on $slots follows the slots the caller actually fills, and a named slot fallback shows only when that slot is empty', () => {
    const dir = repo({
      'src/components/IconButton.vue': [
        '<template><button>',
        '<span v-if="$slots.default"><slot /></span><span v-else>{{ icon }}</span>',
        '<span v-if="!$slots.badge">No badge here</span><slot name="badge">Fallback badge words</slot>',
        '</button></template>',
      ].join(''),
      'src/views/Home.vue': '<template><IconButton><img src="a.png"><template #badge>New</template></IconButton><IconButton icon="close" /></template>',
    })
    const p = price(dir, 'src/views/Home.vue')
    expect(p.byFile['src/views/Home.vue'].units).toEqual({ media: 1, word: 1 })
    expect(p.byFile['src/components/IconButton.vue'].units).toEqual({ control: 2, media: 1, word: 6 })
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

group('render tree', () => {
  test('a traced page names each component it renders, its points and the branch a v-if chain priced', () => {
    const dir = repo({
      'src/components/Panel.vue': '<template><section><h2>Three word title</h2><button>Go</button></section></template>',
      'src/components/Small.vue': '<template><p>One</p></template>',
      'src/views/Home.vue': [
        '<template>',
        '<Panel v-if="tab === \'a\'" />',
        '<Small v-else />',
        '<Small />',
        '</template>',
      ].join('\n'),
    })
    const ctx = session(dir, undefined, { trace: true })
    const p = priceFile(ctx, 'src/views/Home.vue')
    expect(p.tree.points).toBe(p.points)
    const [branch, small] = p.tree.children
    expect(branch).toMatchObject({ kind: 'branch', of: 2, picked: 1, points: 9, line: 2 })
    expect(branch.children).toEqual([expect.objectContaining({ file: 'src/components/Panel.vue', tag: 'Panel', points: 9, when: "v-if tab === 'a'" })])
    expect(small).toMatchObject({ file: 'src/components/Small.vue', tag: 'Small', points: 1, line: 4 })
  })

  test('without trace no tree is built', () => {
    const dir = repo({ 'src/views/Home.vue': '<template><p>Hi</p></template>' })
    expect(price(dir, 'src/views/Home.vue').tree).toBeUndefined()
  })
})

group('conditions known at the call site', () => {
  const props = (decl) => `\n<script setup lang="ts">\ndefineProps<{ ${decl} }>()\n</script>\n`

  test('desktop-only and phone-only parts never add up: the page is its dearer viewport, and says both', () => {
    const dir = repo({
      'src/components/Wide.vue': '<template><section><p>Many words for the wide desktop layout here</p><button>A</button><button>B</button></section></template>',
      'src/components/Narrow.vue': '<template><p>Phone words</p></template>',
      'src/views/Home.vue': '<template><Wide v-if="!state.isMobileViewport" /><p>Shared</p><Narrow v-if="state.isMobileViewport" /></template>',
    })
    const p = price(dir, 'src/views/Home.vue')
    expect(p.byViewport).toEqual({ desktop: 18, phone: 3 })
    expect(p.points).toBe(18)
    expect(p.viewport).toBe('desktop')
    expect(p.byFile['src/components/Narrow.vue']).toBeUndefined()
  })

  test('a prop the caller leaves out is undefined, a literal it passes is known, an unknown one keeps the worst case', () => {
    const dir = repo({
      'src/components/Card.vue':
        '<template><div><h2 v-if="title">{{ title }}</h2><span v-if="icon" class="icon"></span><p v-if="variant === \'long\'">Five words of long copy</p><p v-else>Short</p></div></template>' +
        props("title?: string; icon?: string; variant?: 'long' | 'short'"),
      'src/views/Home.vue': '<template><Card title="Hello" variant="short" /><Card :title="t" /></template>',
    })
    const p = price(dir, 'src/views/Home.vue')
    // first card: title (1 word), no icon, short (1 word); second: title unknown (1 word), no icon, variant undefined -> v-else (1 word)
    expect(p.units).toEqual({ word: 4 })
  })

  test('a literal bound prop, a bare boolean attribute and a forwarded prop all switch the child', () => {
    const dir = repo({
      'src/components/Inner.vue': '<template><p v-if="!compact">Six words only when not compact</p><b>Inner</b></template>' + props('compact?: boolean'),
      'src/components/Outer.vue': '<template><Inner :compact="compact" /><div v-if="!overlay"><button>List</button></div></template>' + props('compact?: boolean; overlay?: boolean'),
      'src/views/Home.vue': '<template><Outer compact :overlay="true" /></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 1 })
  })

  test('sibling v-ifs on one value never show together, and v-show false hides', () => {
    const dir = repo({
      'src/views/Home.vue': [
        '<template>',
        '<div v-if="tab === \'a\'"><p>One two three four five six</p></div>',
        '<div v-if="tab === \'b\'"><p>One two</p></div>',
        '<p v-show="false">Never shown words</p>',
        '<p v-if="ready">Ready</p>',
        '<p v-if="!ready">Not ready yet</p>',
        '</template>',
      ].join('\n'),
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 9 })
  })
})

group('names a component derives from its props', () => {
  test('a computed over props, a props alias and toRefs read through to what the caller passed', () => {
    const dir = repo({
      'src/components/Console.vue': [
        '<template><div v-if="!isOverlay"><p>Seven words of list only copy here</p></div><p v-if="dense">Dense</p><p v-if="label">Label words</p></template>',
        '<script setup lang="ts">',
        "const props = defineProps<{ surface?: string; compact?: boolean; title?: string }>()",
        "const isOverlay = computed(() => props.surface === 'overlay')",
        'const dense = toRef(props, "compact")',
        'const { title: label } = toRefs(props)',
        '</script>',
      ].join('\n'),
      'src/views/Home.vue': '<template><Console surface="overlay" /><Console compact title="Hi" /></template>',
    })
    // first: overlay hides the list, not dense, no label; second: list (7), dense (1), label (2)
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 10 })
  })
})

group('closed on arrival', () => {
  const detail = '<template><section><h2>Five words of row detail</h2><button>Save</button></section></template>'
  const page = (template, script = '') =>
    `<template>${template}</template>\n<script setup lang="ts">\nimport { ref } from 'vue'\nimport RowDetail from '../components/RowDetail.vue'\nimport PickHint from '../components/PickHint.vue'\n${script}\n</script>\n`
  const tree = (template, script) => ({
    'src/components/RowDetail.vue': detail,
    'src/components/PickHint.vue': '<template><p>Pick a row</p></template>',
    'src/views/List.vue': page(template, script),
  })

  test('a detail shown only once the person picks a row costs nothing on arrival', () => {
    const dir = repo(tree('<p>Rows</p><RowDetail v-if="selectedRow" />', 'const selectedRow = ref(null)'))
    expect(price(dir, 'src/views/List.vue').units).toEqual({ word: 1 })
  })

  test('with an else, the else is what shows on arrival', () => {
    const dir = repo(tree('<RowDetail v-if="selectedRow" /><PickHint v-else />', 'const selectedRow = ref(null)'))
    expect(price(dir, 'src/views/List.vue').units).toEqual({ word: 3 })
  })

  test('a flag the script starts as true, a comparison, and a name that says nothing about opening still count', () => {
    const started = repo(tree('<RowDetail v-if="expanded" />', 'const expanded = ref(true)'))
    expect(price(started, 'src/views/List.vue').units.word).toBe(6)
    const compared = repo(tree("<RowDetail v-if=\"selectedTab === 'a'\" /><PickHint v-else-if=\"selectedTab === 'b'\" />", "const selectedTab = ref('a')"))
    expect(price(compared, 'src/views/List.vue').units.word).toBe(6)
    const mounted = repo(tree('<RowDetail v-if="mounted" />', 'const mounted = ref(false)'))
    expect(price(mounted, 'src/views/List.vue').units.word).toBe(6)
  })

  test('a prop the caller passes as true opens it', () => {
    const dir = repo({
      'src/components/RowDetail.vue': detail,
      'src/components/Drawerless.vue':
        '<template><RowDetail v-if="open" /></template>\n<script setup lang="ts">\nimport RowDetail from \'./RowDetail.vue\'\ndefineProps<{ open?: boolean }>()\n</script>\n',
      'src/views/List.vue': '<template><Drawerless :open="true" /></template>\n<script setup lang="ts">\nimport Drawerless from \'../components/Drawerless.vue\'\n</script>\n',
    })
    expect(price(dir, 'src/views/List.vue').units.word).toBe(6)
  })
})

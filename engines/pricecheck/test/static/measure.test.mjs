import { describe as group, expect, test } from 'bun:test'
import '../home.mjs'
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
    expect(p.byFile['src/components/SignInFooterBar.vue']).toEqual({ points: 9, units: { control: 2, word: 4, media: 1 }, uses: 1 })
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
    expect(p.points).toBe(3)
    expect(p.byFile['src/components/Badge.vue'].points).toBe(3)
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
    expect(branch).toMatchObject({ kind: 'branch', of: 2, picked: 1, points: 27, line: 2 })
    expect(branch.children).toEqual([expect.objectContaining({ file: 'src/components/Panel.vue', tag: 'Panel', points: 27, when: "v-if tab === 'a'" })])
    expect(small).toMatchObject({ file: 'src/components/Small.vue', tag: 'Small', points: 3, line: 4 })
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
    expect(p.byViewport).toEqual({ desktop: 52, phone: 7 })
    expect(p.points).toBe(52)
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

  test('a member of an object the caller passes, or of a computed object over props, is known', () => {
    const dir = repo({
      'src/components/Dock.vue': [
        "<template><div v-if=\"showPanel\"><p>Six words of panel only copy</p></div><p v-if=\"look.tone === 'plain'\">Plain</p></template>",
        '<script setup lang="ts">',
        'const props = defineProps<{ surface?: { panel?: boolean; tone?: string } }>()',
        "const look = computed(() => ({ panel: props.surface?.panel ?? false, tone: props.surface?.tone ?? 'plain' }))",
        'const showPanel = computed(() => look.value.panel)',
        '</script>',
      ].join('\n'),
      'src/views/Home.vue': "<template><Dock :surface=\"{ tone: 'plain' }\" /><Dock :surface=\"{ panel: true }\" /><Dock :surface=\"opts\" /></template>",
    })
    // first: no panel, plain (1); second: panel (6), tone falls back to plain (1); third: unknown, the worst case (7)
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 15 })
  })

  test('a prop left out takes its object default, so a member it lacks is undefined', () => {
    const dir = repo({
      'src/components/Field.vue': [
        '<template><input><button v-if="cfg.copyable">Copy</button></template>',
        '<script setup lang="ts">',
        'const props = withDefaults(defineProps<{ control?: { copyable?: boolean } }>(), { control: () => ({}) })',
        'const cfg = computed(() => ({ copyable: props.control.copyable ?? false }))',
        '</script>',
      ].join('\n'),
      'src/views/Home.vue': '<template><Field /><Field :control="{ copyable: true }" /></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ field: 2, control: 1, word: 1 })
  })

  test('an object default a prop takes when the caller leaves it out decides a v-if on its members', () => {
    const dir = repo({
      'src/components/Tile.vue': [
        "<template><p v-if=\"opts.size === 'wide'\">Wide copy here</p><p v-else>Narrow</p></template>",
        '<script setup lang="ts">',
        "withDefaults(defineProps<{ opts?: { size?: string } }>(), { opts: () => ({ size: 'wide' }) })",
        '</script>',
      ].join('\n'),
      'src/views/Home.vue': "<template><Tile /><Tile :opts=\"{ size: 'slim' }\" /></template>",
    })
    // first: the default is wide (3); second: slim shows the else (1)
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 4 })
  })

  test('a computed object that spreads a prop does not know the keys the spread may overwrite', () => {
    const dir = repo({
      'src/components/Chip.vue': [
        "<template><p v-if=\"cfg.tone === 'loud'\">Loud copy here</p></template>",
        '<script setup lang="ts">',
        'const props = defineProps<{ extra?: { tone?: string } }>()',
        "const cfg = computed(() => ({ tone: 'plain', ...props.extra }))",
        '</script>',
      ].join('\n'),
      'src/views/Home.vue': "<template><Chip :extra=\"{ tone: 'loud' }\" /></template>",
    })
    // the spread may replace tone, so the v-if is unknown and its copy counts (3), not dropped as plain
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 3 })
  })
})

group('what a page passes into a component shows only where the component shows it', () => {
  test('content inside a dock that opens only once a row is picked costs nothing on arrival', () => {
    const dir = repo({
      'src/components/AppSideSheet.vue': '<template><aside><slot /></aside></template>',
      'src/components/Dock.vue':
        '<template><AppSideSheet :open="visible"><button>Close</button><slot /></AppSideSheet></template>\n<script setup lang="ts">\ndefineProps<{ visible: boolean }>()\n</script>\n',
      'src/views/List.vue': '<template><p>Rows</p><Dock :visible="Boolean(activeId)"><h2>Five words of row detail</h2><button>Save</button></Dock></template>',
    })
    const p = price(dir, 'src/views/List.vue')
    expect(p.units).toEqual({ word: 1 })
    expect(Object.keys(p.byFile)).toEqual(['src/views/List.vue'])
  })

  test('a slot the component shows under a condition that is false, or a named slot it leaves out, costs nothing', () => {
    const dir = repo({
      'src/components/Panel.vue':
        '<template><div v-if="open"><slot /></div><p v-else>Closed</p><footer v-if="showFooter"><slot name="footer" /></footer></template>\n<script setup lang="ts">\ndefineProps<{ open?: boolean; showFooter?: boolean }>()\n</script>\n',
      'src/views/Home.vue': '<template><Panel><p>Four hidden words here</p><template #footer><button>Done</button></template></Panel><Panel open><p>Shown</p></Panel></template>',
    })
    const p = price(dir, 'src/views/Home.vue')
    expect(p.units).toEqual({ word: 2 })
    expect(p.byFile['src/views/Home.vue'].units).toEqual({ word: 1 })
  })

  test('content passed to a component whose markup shows no slot (JSX children) still counts', () => {
    const dir = repo({
      'src/components/Box.tsx': 'export default function Box({ children }) { return <div className="box">{children}</div> }',
      'src/pages/Home.tsx': "import Box from '../components/Box'\nexport default function Home() { return <Box><p>Three words here</p></Box> }",
    })
    expect(price(dir, 'src/pages/Home.tsx').byFile['src/pages/Home.tsx'].units.word).toBe(3)
  })

  test('a named slot the component shows only under a condition the caller leaves false costs nothing', () => {
    const dir = repo({
      'src/components/Shell.vue': '<template><p>Shell</p><div v-if="hasExtra"><slot name="extra" /></div></template>\n<script setup lang="ts">\ndefineProps<{ hasExtra?: boolean }>()\n</script>\n',
      'src/views/Home.vue': '<template><Shell><template #extra><p>Four hidden words here</p></template></Shell><Shell hasExtra><template #extra><p>Two words</p></template></Shell></template>',
    })
    // "Shell" prints twice (2); the first instance hides its extra, the second shows "Two words" (2)
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 4 })
  })

  test('a default slot shows its fallback only when the caller passes nothing, and its passed content otherwise', () => {
    const dir = repo({
      'src/components/Card.vue': '<template><div><slot>Fallback has four words</slot></div></template>',
      'src/views/Home.vue': '<template><Card /><Card><p>Passed copy</p></Card></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 6 })
  })

  test('a scoped slot the caller fills is priced for the copy it passes, whatever scope it binds', () => {
    const dir = repo({
      'src/components/RowList.vue': '<template><ul><slot name="row" :row="{ id: 1 }" /></ul></template>',
      'src/views/Home.vue': '<template><RowList><template #row="{ row }"><p>Scoped row copy here</p></template></RowList></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 4 })
  })

  test('an outlet whose name is bound keeps all the caller content, since which slot it shows is unknown', () => {
    const dir = repo({
      'src/components/Host.vue': '<template><div><slot :name="slotName" /></div></template>\n<script setup lang="ts">\ndefineProps<{ slotName: string }>()\n</script>\n',
      'src/views/Home.vue': '<template><Host><p>Dynamic keeps this</p></Host></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 3 })
  })

  test('a named slot inside a dock that opens only once a row is picked costs nothing on arrival', () => {
    const dir = repo({
      'src/components/AppSideSheet.vue': '<template><aside><slot /></aside></template>',
      'src/components/Dock.vue':
        '<template><AppSideSheet :open="visible"><slot name="detail" /></AppSideSheet></template>\n<script setup lang="ts">\ndefineProps<{ visible: boolean }>()\n</script>\n',
      'src/views/List.vue': '<template><p>Rows</p><Dock :visible="Boolean(activeId)"><template #detail><h2>Five words of row detail</h2></template></Dock></template>',
    })
    expect(price(dir, 'src/views/List.vue').units).toEqual({ word: 1 })
  })

  test('a JSX component with no children outlet keeps the content passed to it, since nothing says it is hidden', () => {
    const dir = repo({
      'src/components/Plain.tsx': 'export default function Plain() { return <p>Fixed</p> }',
      'src/pages/Home.tsx': "import Plain from '../components/Plain'\nexport default function Home() { return <Plain><p>Kept copy here</p></Plain> }",
    })
    // "Fixed" (1) in the component plus the kept copy (3)
    expect(price(dir, 'src/pages/Home.tsx').units).toEqual({ word: 4 })
  })

  test('a chain of components deeper than the depth limit keeps all the caller content', () => {
    const tree = { 'src/views/Home.vue': '<template><Link0><p>Deep copy here</p></Link0></template>' }
    const depth = 30
    for (let i = 0; i < depth; i++) {
      const inner = i + 1 < depth ? `<Link${i + 1}><slot /></Link${i + 1}>` : '<slot />'
      tree[`src/components/Link${i}.vue`] = `<template>${inner}</template>`
    }
    expect(price(repo(tree), 'src/views/Home.vue').units.word).toBe(3)
  })

  test('a sheet told to render while closed keeps the content it wraps on arrival', () => {
    const dir = repo({
      'src/components/RowSheet.vue': '<template><aside><slot /></aside></template>',
      'src/components/Strip.vue':
        '<template><RowSheet :open="visible" :behavior="{\n  collapseWhenClosed: true,\n  renderWhenClosed: true,\n}"><slot /></RowSheet></template>\n<script setup lang="ts">\ndefineProps<{ visible: boolean }>()\n</script>\n',
      'src/views/Ledger.vue': '<template><p>Rows</p><Strip :visible="Boolean(pickedId)"><h2>Five words of row detail</h2></Strip></template>',
    })
    expect(price(dir, 'src/views/Ledger.vue').units).toEqual({ word: 6 })
  })

  test('a sheet not told to render while closed still drops its content on arrival', () => {
    const dir = repo({
      'src/components/RowSheet.vue': '<template><aside><slot /></aside></template>',
      'src/components/Strip.vue':
        '<template><RowSheet :open="visible" :behavior="{ renderWhenClosed: false }"><slot /></RowSheet></template>\n<script setup lang="ts">\ndefineProps<{ visible: boolean }>()\n</script>\n',
      'src/views/Ledger.vue': '<template><p>Rows</p><Strip :visible="Boolean(pickedId)"><h2>Five words of row detail</h2></Strip></template>',
    })
    expect(price(dir, 'src/views/Ledger.vue').units).toEqual({ word: 1 })
  })

  test('caller content inside a slot of a branch that loses the pick costs nothing', () => {
    const dir = repo({
      'src/components/Panes.vue':
        '<template><div v-if="isDetailOverlay"><slot /></div><div v-else><p>Plain pane words here, five</p></div></template>\n<script setup lang="ts">\ndefineProps<{ isDetailOverlay?: boolean }>()\n</script>\n',
      'src/views/Home.vue': '<template><Panes><h2>Caller copy words</h2></Panes></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units).toEqual({ word: 5 })
  })

  test('a slot in a branch a forwarded prop from the page makes dead costs nothing', () => {
    const dir = repo({
      'src/components/Panes.vue':
        '<template><div v-if="isDetailOverlay"><slot /></div><div v-else><p>Plain pane words</p></div></template>\n<script setup lang="ts">\ndefineProps<{ isDetailOverlay?: boolean }>()\n</script>\n',
      'src/components/Console.vue':
        '<template><section><Panes :is-detail-overlay="isDetailOverlay"><h2>Five words of row detail</h2></Panes></section></template>\n<script setup lang="ts">\nconst props = withDefaults(defineProps<{ surface?: "full" | "detail-overlay" }>(), { surface: "full" })\nconst isDetailOverlay = computed(() => props.surface === "detail-overlay")\n</script>\n',
      'src/views/Home.vue': '<template><Console /></template>',
    })
    expect(price(dir, 'src/views/Home.vue').units.word).toBe(3)
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

group('flags that end in a literal, dotted selection state, and a constant passed down', () => {
  const sfc = (template, script) => `<template>${template}</template>\n<script setup lang="ts">\n${script}\n</script>\n`
  const widget = sfc(
    '<div><input /><button v-if="boxConfig.copyable">Copy this value</button></div>',
    [
      "import { computed, useAttrs } from 'vue'",
      'const props = defineProps<{ box?: { copyable?: boolean } }>()',
      'const attrs = useAttrs()',
      'function readAttrFlag(name: string) { return attrs[name] === undefined ? undefined : Boolean(attrs[name]) }',
      'const boxConfig = computed<{ copyable: boolean }>(() => ({',
      "  copyable: props.box?.copyable ?? readAttrFlag('copyable') ?? false,",
      '}))',
    ].join('\n'),
  )
  const use = (tag) => repo({
    'src/components/QuillBox.vue': widget,
    'src/views/Form.vue': sfc(tag, "import QuillBox from '../components/QuillBox.vue'"),
  })
  const words = (dir) => price(dir, 'src/views/Form.vue').units.word ?? 0

  test('a flag that ends in the literal false hides its button when the caller passes nothing', () => {
    expect(price(use('<QuillBox />'), 'src/views/Form.vue').units.control ?? 0).toBe(0)
  })

  test('the same flag shows its button when the caller passes the member, the attribute, or something unknown', () => {
    expect(price(use('<QuillBox :box="{ copyable: true }" />'), 'src/views/Form.vue').units.control).toBe(1)
    expect(price(use('<QuillBox copyable />'), 'src/views/Form.vue').units.control).toBe(1)
    expect(price(use('<QuillBox :box="someBox" />'), 'src/views/Form.vue').units.control).toBe(1)
    expect(price(use('<QuillBox v-bind="rest" />'), 'src/views/Form.vue').units.control).toBe(1)
  })

  const pick = (script, template = '<p>Events</p><DetailPane v-if="ctx.hostEvents.selectedEventId" />') =>
    repo({
      'src/components/DetailPane.vue': '<template><section><h2>Five words of row detail</h2></section></template>',
      'src/views/Events.vue': sfc(template, `import { ref } from 'vue'\nimport DetailPane from '../components/DetailPane.vue'\n${script}`),
    })

  test('selection state reached through nested objects is closed on arrival', () => {
    expect(price(pick('const ctx = useHost()'), 'src/views/Events.vue').units).toEqual({ word: 1 })
    expect(price(pick('const ctx = useHost()', '<p>Events</p><DetailPane v-if="ctx?.hostEvents?.selectedEventId" />'), 'src/views/Events.vue').units).toEqual({ word: 1 })
  })

  test('dotted selection state still counts when the script starts it or a load hook sets it', () => {
    expect(price(pick("const ctx = useHost()\nconst selectedEventId = ref('first')"), 'src/views/Events.vue').units.word).toBe(6)
    expect(price(pick("const ctx = useHost()\nonMounted(() => { selectedEventId.value = 'first' })\nconst selectedEventId = ref(null)"), 'src/views/Events.vue').units.word).toBe(6)
  })

  const drawer = {
    'src/components/ExtrasPanel.vue': sfc('<section v-if="open"><h2>Five words of extra detail</h2></section>', 'defineProps<{ open?: boolean }>()'),
  }
  const parent = (script, tag = '<ExtrasPanel :open="showExtras" />') =>
    repo({ ...drawer, 'src/views/Settings.vue': sfc(`<p>Settings</p>${tag}`, `import { ref, onMounted } from 'vue'\nimport ExtrasPanel from '../components/ExtrasPanel.vue'\n${script}`) })
  const settingsWords = (dir) => price(dir, 'src/views/Settings.vue').units.word

  test('a constant false passed to a child that shows on open keeps the child closed, under any prop name', () => {
    expect(settingsWords(parent('const showExtras = false'))).toBe(1)
    expect(settingsWords(parent('const showExtras = ref(false)'))).toBe(1)
  })

  test('a ref(false) set in onMounted, or a constant true, opens the child', () => {
    expect(settingsWords(parent('const showExtras = ref(false)\nonMounted(() => { showExtras.value = true })'))).toBe(6)
    expect(settingsWords(parent('const showExtras = true'))).toBe(6)
  })
})

group('hidden on arrival (misprices)', () => {
  test('screen-reader-only text, by class or by component name, costs nothing', () => {
    const dir = repo({
      'src/components/VisuallyHidden.vue': '<template><span><slot /></span></template>',
      'src/views/Ledger.vue': [
        '<template><h1>Quarterly ledger</h1>',
        '<span class="sr-only">Skip to the ledger totals</span>',
        '<p class="note visually-hidden">Hidden words about ledger rows <b>more</b></p>',
        '<VisuallyHidden>Spoken only to readers</VisuallyHidden></template>',
      ].join(''),
    })
    expect(price(dir, 'src/views/Ledger.vue').units).toEqual({ word: 2 })
  })

  test('a flyout is closed on arrival like the other overlays', () => {
    const dir = repo({
      'src/components/QuillFlyout.vue': '<template><div><button>Shut</button><slot /></div></template>',
      'src/components/QuillFlyoutSurface.vue': '<template><div><slot /></div></template>',
      'src/views/Ledger.vue': '<template><QuillFlyout><p>Many words inside the flyout</p></QuillFlyout><QuillFlyoutSurface><p>More flyout words</p></QuillFlyoutSurface><h1>Ledger</h1></template>',
    })
    expect(price(dir, 'src/views/Ledger.vue').units).toEqual({ word: 1 })
  })

  test('a bulk header shown only while rows are selected is closed on arrival', () => {
    const dir = repo({
      'src/views/Ledger.vue': [
        '<template><table><tr v-if="showBulkHeader"><th>Rows chosen for action</th></tr><tr><td>Row</td></tr></table></template>',
        '<script setup>',
        'const selectedRows = ref([])',
        'const showBulkHeader = computed(() => selectedRows.value.length > 0)',
        '</script>',
      ].join('\n'),
    })
    expect(price(dir, 'src/views/Ledger.vue').units).toEqual({ word: 1 })
  })
})

group('uses', () => {
  const tree = (n, nested) => ({
    'src/views/Quux.vue': `<script setup>\nimport Zorp from '../ui/Zorp.vue'\n</script>\n<template>\n  <main><h1>Quux page title</h1>${'<Zorp />'.repeat(n)}</main>\n</template>\n`,
    'src/ui/Zorp.vue': nested
      ? `<script setup>\nimport Blip from './Blip.vue'\n</script>\n<template>\n  <div><b>Zorp label</b><Blip /></div>\n</template>\n`
      : '<template>\n  <button>Open the panel</button>\n</template>\n',
    'src/ui/Blip.vue': '<template>\n  <span>Blip words here</span>\n</template>\n',
  })

  test('a page rendering a component three times has uses 3, and byFile still sums to the points', () => {
    const p = price(repo(tree(3)), 'src/views/Quux.vue')
    expect(p.byFile['src/ui/Zorp.vue'].uses).toBe(3)
    expect(p.byFile['src/views/Quux.vue'].uses).toBe(1)
    expect(Math.round(sum(p.byFile) * 10) / 10).toBe(p.points)
  })

  test('a component inside a cached component is counted once for each render of the outer one', () => {
    const p = price(repo(tree(3, true)), 'src/views/Quux.vue')
    expect(p.byFile['src/ui/Zorp.vue'].uses).toBe(3)
    expect(p.byFile['src/ui/Blip.vue'].uses).toBe(3)
  })
})

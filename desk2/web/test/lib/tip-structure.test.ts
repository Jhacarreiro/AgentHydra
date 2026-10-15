// Two ways a Tip breaks the control it wraps, checked in every component's template. No DOM here: the templates are read
// with Vue's own compiler.
//
// 1. Tip swaps its subtree on the first hover (InterestSlot -> real Tooltip), which remounts everything inside it. A Tip
//    placed between a DropdownMenu or Popover and its trigger leaves the menu anchored to a detached button at 0,0, the
//    top left of the window (the Connections chip, then the model chip; owner, 2026-10-15: "when I click on the word,
//    like Sonnet 5.5, it shows up in the top left"). Tip must wrap the WHOLE menu, as in session-header/SessionHeader.vue.
// 2. Tip renders no element of its own, so a listener a caller puts on a component whose root is a Tip falls through to
//    nothing. Such a component must declare every event its callers bind (owner, 2026-10-15, of the transcript's
//    "Using hswarm >" row: "The arrow here doesn't work when I click it").

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { parse } from 'vue/compiler-sfc'

interface Node {
  type: number
  tag?: string
  name?: string
  arg?: { content?: string }
  props?: Node[]
  children?: Node[]
}

const ELEMENT = 1
const DIRECTIVE = 7
const SRC = join(import.meta.dir, '..', '..', 'src')

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) vueFiles(p, out)
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}

const files = vueFiles(SRC).map((p) => {
  const { descriptor } = parse(readFileSync(p, 'utf8'))
  return { file: relative(SRC, p).replaceAll('\\', '/'), name: basename(p, '.vue'), descriptor, root: descriptor.template?.ast as unknown as Node | undefined }
})

const elements = (n: Node | undefined) => (n?.children ?? []).filter((c) => c.type === ELEMENT)
const key = (tag: string) => tag.replaceAll('-', '').toLowerCase()

/** Every element under `n`, with the tags of its ancestors from the template root down. */
function walk(n: Node | undefined, visit: (el: Node, trail: string[]) => void, trail: string[] = []): void {
  for (const c of elements(n)) {
    visit(c, trail)
    walk(c, visit, [...trail, c.tag!])
  }
}

test('no Tip sits between a menu and its trigger, so the first hover cannot detach what the menu anchors to', () => {
  const MENUS: Record<string, string> = { dropdownmenutrigger: 'dropdownmenu', popovertrigger: 'popover' }
  const bad: string[] = []
  let triggers = 0
  for (const f of files) {
    walk(f.root, (el, trail) => {
      const menu = MENUS[key(el.tag!)]
      if (!menu) return
      triggers++
      const tags = trail.map(key)
      const at = tags.lastIndexOf(menu)
      if (at < 0) return
      // With a PopoverAnchor the card hangs off it, not the trigger, so only a Tip above the anchor detaches it
      // (sidebar/ManagerAvatar.vue keeps its Tip under the anchor).
      const anchor = tags.lastIndexOf('popoveranchor')
      if (tags.slice(at, anchor > at ? anchor : undefined).includes('tip')) bad.push(`${f.file}: <${el.tag}>`)
    })
  }
  expect(triggers).toBeGreaterThan(20)
  expect(bad).toEqual([])
})

/** The events a component declares with `defineEmits<{ a: []; 'b:c': [x] }>()` or `defineEmits(['a'])`. */
function emitsOf(script: string): Set<string> {
  const decl = /defineEmits\s*(?:<\s*\{([\s\S]*?)\}\s*>\s*\(\s*\)|\(\s*\[([\s\S]*?)\]\s*\))/.exec(script)
  if (!decl) return new Set()
  const body = decl[1] ?? decl[2] ?? ''
  const names = decl[1] !== undefined ? body.matchAll(/(['"]?)([\w:-]+)\1\s*:\s*\[/g) : body.matchAll(/(['"])([\w:-]+)\1/g)
  return new Set([...names].map((m) => m[2]!))
}

test('a component whose root is a Tip declares every event its callers bind, so none falls through to nothing', () => {
  const tipRoots = new Map<string, Set<string>>()
  for (const f of files) {
    const roots = elements(f.root)
    if (roots.length === 1 && key(roots[0]!.tag!) === 'tip') {
      tipRoots.set(key(f.name), emitsOf(`${f.descriptor.scriptSetup?.content ?? ''}\n${f.descriptor.script?.content ?? ''}`))
    }
  }
  expect(tipRoots.size).toBeGreaterThan(5)

  const bad: string[] = []
  for (const f of files) {
    walk(f.root, (el) => {
      const emits = tipRoots.get(key(el.tag!))
      if (!emits) return
      for (const p of el.props ?? []) {
        if (p.type !== DIRECTIVE) continue
        const event = p.name === 'on' ? p.arg?.content : p.name === 'model' ? `update:${p.arg?.content ?? 'modelValue'}` : undefined
        if (event && !emits.has(event)) bad.push(`${f.file}: <${el.tag} @${event}>`)
      }
    })
  }
  expect(bad).toEqual([])
})

// pricecheck/lib/static/measure.mjs - the static measurer: reads a page's markup and every component it renders, and
// emits attributed items (model.mjs) that rollup() turns into the page's price. A component's items belong to the file
// that wrote them, so a page's byFile shares add up to its points.
import fs from 'node:fs'
import path from 'node:path'
import { rollup } from '../model.mjs'
import { loadConfig } from '../config.mjs'
import { discoverPages } from './discover.mjs'
import { readTemplate } from './templates.mjs'
import { makeI18n } from './i18n.mjs'
import { makeGraph } from './graph.mjs'
import { UNKNOWN, declaredProps, derivedNames, evaluate, literal, propsOf, viewportFlag } from './conditions.mjs'

const MAX_DEPTH = 25
const MEDIA = new Set(['img', 'picture', 'video', 'canvas', 'iframe', 'svg', 'object', 'embed'])
const CONTROL_ROLES = new Set(['button', 'tab', 'switch', 'checkbox', 'menuitem', 'link', 'radio'])
const LINKS = new Set(['a', 'router-link', 'routerlink', 'nuxt-link', 'nuxtlink', 'link'])
const RENDERS_CONTROL = /(^|['"`])(button|a|router-link|RouterLink|NuxtLink)(['"`]|$)|\b(RouterLink|NuxtLink)\b/
const BUTTON_INPUTS = new Set(['button', 'submit', 'reset', 'image'])
const ICON_CLASS = /(^|\s)(icon|material-icons|fa-[\w-]+|bi-[\w-]+)(\s|$)/
const CARD_CLASS = /(^|\s)(card|tile)(\s|$)/

export const wordsIn = (s) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length

/** One pricing pass over a repo. `trace: true` also builds each page's render tree (priceFile's `tree`). */
export function session(root, readFile, { trace = false } = {}) {
  const cfg = loadConfig(root)
  const read =
    readFile ??
    ((f) => {
      try {
        return fs.readFileSync(path.join(root, f), 'utf8')
      } catch {
        return null
      }
    })
  return {
    root,
    cfg,
    list: cfg.list,
    i18n: makeI18n(root),
    graph: makeGraph(root, cfg),
    read,
    trace,
    templates: new Map(),
    children: new Map(),
    owned: new Map(),
    props: new Map(),
    derived: new Map(),
    names: new Map(),
    viewport: null,
    sawViewport: false,
  }
}

function parsed(ctx, file) {
  if (ctx.templates.has(file)) return ctx.templates.get(file)
  const src = ctx.read(file)
  const t = src == null ? null : readTemplate(file, src)
  ctx.templates.set(file, t)
  return t
}

const weigh = (ctx, items) => items.reduce((s, it) => s + it.count * (ctx.list[it.unit]?.weight ?? 0), 0)
const round = (n) => Math.round(n * 10) / 10
const whenOf = (attrs) => {
  if ('v-if' in attrs) return `v-if ${attrs['v-if']}`
  if ('v-else-if' in attrs) return `v-else-if ${attrs['v-else-if']}`
  return 'v-else' in attrs ? 'v-else' : undefined
}

/**
 * Of alternatives that never show together, the dearest: each run(sc) prices one branch. The traced tree keeps only
 * the priced branch's components, under a node saying which of how many it was.
 */
function priceBranches(ctx, sc, runs, line, of = runs.length, ids = runs.map((_, k) => k + 1)) {
  let best = { items: [], tree: [] }
  let bestW = -1
  let picked = 0
  runs.forEach((run, k) => {
    const tree = ctx.trace ? [] : null
    const items = run(tree ? { ...sc, tree } : sc)
    const w = weigh(ctx, items)
    if (w > bestW) {
      best = { items, tree }
      bestW = w
      picked = ids[k]
    }
  })
  if (ctx.trace && best.tree) {
    if (of > 1) sc.tree.push({ kind: 'branch', at: sc.file, line, of, picked, points: round(Math.max(0, bestW)), children: best.tree })
    else sc.tree.push(...best.tree)
  }
  return best.items
}

/**
 * What a name in this component's conditions holds: the viewport being priced for a layout flag, a slot the caller
 * fills, a prop the caller passed (or its declared default when it passed none), else UNKNOWN.
 */
function lookIn(ctx, sc) {
  const layout = (p) => {
    const flag = ctx.viewport && viewportFlag(p)
    if (!flag) return UNKNOWN
    ctx.sawViewport = true
    return ctx.viewport === flag
  }
  let depth = 0
  const look = (raw) => {
    const p = raw.replace(/\?\./g, '.').replace(/^(props|\$props|this)\./, '').replace(/\.value$/, '')
    const [root, ...rest] = p.split('.')
    if ((root === '$slots' || root === 'slots') && sc.slots && rest.length === 1) return sc.slots.has(rest[0])
    const env = sc.env
    if (env && Object.hasOwn(env, root)) return rest.length ? UNKNOWN : env[root]
    if (env && !env['...'] && sc.declared?.has(root)) return rest.length ? UNKNOWN : sc.declared.get(root)
    if (sc.derived?.has(root) && !rest.length && depth < 8) {
      depth++
      try {
        return valueOf(sc.derived.get(root), look)
      } finally {
        depth--
      }
    }
    return layout(p)
  }
  return look
}

/** What an expression holds: a literal, a name's value, else its truth (UNKNOWN when that is unknown too). */
function valueOf(expr, look) {
  const s = expr.trim()
  const lit = literal(s)
  if (lit !== UNKNOWN) return lit
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(s)) return look(s)
  const v = evaluate(s, look)
  return v === null ? UNKNOWN : v
}

/** A condition's truth for this component instance: true, false or null (unknown, priced as possibly shown). */
function truthOf(ctx, sc, expr) {
  const slot = slotTest(expr, sc.slots)
  return slot !== null ? slot : evaluate(expr, lookIn(ctx, sc))
}

/** Of a chain's conditions in order (null = else), the indexes that may show: a false one never, nothing past a true one. */
function liveBranches(ctx, sc, conds) {
  const live = []
  for (let k = 0; k < conds.length; k++) {
    const v = conds[k] == null ? true : truthOf(ctx, sc, conds[k])
    if (v === false) continue
    live.push(k)
    if (v === true) break
  }
  return live
}

const EQ_TEST = /^\s*([A-Za-z_$][\w$.]*)\s*===?\s*(['"`][^'"`]*['"`]|-?\d+)\s*$|^\s*(['"`][^'"`]*['"`]|-?\d+)\s*===?\s*([A-Za-z_$][\w$.]*)\s*$/
const bare = (expr) => String(expr).replace(/\s+/g, '')

/**
 * Whether a v-if chain that follows another can never show at the same time as it: both test one name against
 * different literals (`tab === 'a'` then `tab === 'b'`), or one is the other's negation (`ready` then `!ready`).
 */
function exclusive(chain, next) {
  if ([...chain, ...next].some((b) => 'v-else' in b.attrs)) return false
  const conds = (bs) => bs.map((b) => b.attrs['v-if'] ?? b.attrs['v-else-if'])
  const a = conds(chain)
  const b = conds(next)
  if (a.includes(undefined) || b.includes(undefined)) return false
  if (a.length === 1 && b.length === 1) {
    const [x, y] = [bare(a[0]), bare(b[0])]
    if (x === `!${y}` || y === `!${x}` || x === `!(${y})` || y === `!(${x})`) return true
  }
  const eq = (c) => {
    const m = EQ_TEST.exec(c)
    return m ? { name: m[1] ?? m[4], lit: m[2] ?? m[3] } : null
  }
  const all = [...a, ...b].map(eq)
  if (all.includes(null)) return false
  return all.every((t) => t.name === all[0].name) && new Set(all.map((t) => t.lit)).size === all.length
}

const IDENT = /[A-Za-z_$][\w$]*/g

/** The names a component's conditions and bound attributes read: what its price can depend on from the caller. */
function namesRead(ctx, file, root) {
  if (ctx.names.has(file)) return ctx.names.get(file)
  const names = new Set()
  const add = (expr) => {
    for (const m of String(expr).replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, '').matchAll(IDENT)) names.add(m[0])
  }
  const visit = (kids) => {
    for (const k of kids) {
      if (k.type !== 'el') continue
      for (const [a, v] of Object.entries(k.attrs)) {
        if (a === 'v-if' || a === 'v-else-if' || a === 'v-show' || a.startsWith(':') || a.startsWith('v-bind') || (typeof v === 'string' && v.startsWith('{'))) add(v)
      }
      if (Array.isArray(k.attrs.when)) k.attrs.when.forEach(add)
      visit(k.children)
    }
  }
  visit(root.children)
  // A name the script derives from props (`isOverlay = computed(() => props.surface === ...)`) reads those props.
  declaredOf(ctx, file)
  const derived = ctx.derived.get(file)
  const seen = new Set()
  for (let grew = true; grew; ) {
    grew = false
    for (const n of [...names]) {
      if (derived.has(n) && !seen.has(n)) {
        seen.add(n)
        add(derived.get(n))
        grew = true
      }
    }
  }
  ctx.names.set(file, names)
  return names
}

function declaredOf(ctx, file) {
  if (!ctx.props.has(file)) {
    const src = ctx.read(file)
    ctx.props.set(file, declaredProps(src, file))
    ctx.derived.set(file, derivedNames(src))
  }
  return ctx.props.get(file)
}

/** The part of a child's props its price can depend on, as a memo key. */
function envKey(env, names) {
  const parts = []
  for (const k of Object.keys(env).sort()) {
    if (k !== '...' && !names.has(k)) continue
    const v = env[k]
    parts.push(`${k}=${v === UNKNOWN ? '?' : JSON.stringify(v) ?? 'u'}`)
  }
  return parts.join('&')
}

// An expression named like an icon (`icon`, `item.leadingIcon`) prints an icon font's glyph name: media, not a word.
const ICON_EXPR = /(^|\.)\w*icon$/i

function textItems(ctx, sc, node) {
  let icons = 0
  const s = node.text.replace(/\u0001(\d+)\u0002/g, (_, n) => {
    if (ICON_EXPR.test(String(sc.exprs[+n] ?? '').trim())) {
      icons++
      return ' '
    }
    return ctx.i18n.text(sc.exprs[+n]) ?? ' x '
  })
  const count = wordsIn(s)
  const items = count ? [{ unit: 'word', count, file: sc.file, line: node.line }] : []
  if (icons) items.push({ unit: 'media', count: icons, file: sc.file, line: node.line, note: 'icon glyph' })
  return items
}

function countOptions(el) {
  let n = 0
  const walkKids = (kids) => {
    for (const k of kids) {
      if (k.type !== 'el') continue
      if (k.tag.toLowerCase() === 'option') n++
      walkKids(k.children)
    }
  }
  walkKids(el.children)
  return n
}

function classify(ctx, sc, el, cond) {
  const tag = el.tag.toLowerCase()
  const a = el.attrs
  const type = String(a.type ?? '').toLowerCase()
  const role = String(a.role ?? '').toLowerCase()
  const cls = String(a.class ?? a.className ?? '')
  const href = String(a.href ?? a.to ?? '')
  const at = (unit, note) => ({ unit, count: 1, file: sc.file, line: el.line, note })
  const own = []
  let descend = true

  if (tag === 'option') return { own, descend: false }
  if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') {
    if (!cond && !('v-show' in a)) own.push(at('interruption', 'dialog shown on arrival'))
  }
  if (tag === 'select') {
    own.push(at('field', '<select>'))
    const extra = Math.max(0, countOptions(el) - 1)
    if (extra) own.push({ unit: 'choice', count: extra, file: sc.file, line: el.line, note: '<option>s past the first' })
    descend = false
  } else if (tag === 'textarea') own.push(at('field', '<textarea>'))
  else if (tag === 'input') {
    if (type === 'hidden') return { own, descend: false }
    if (BUTTON_INPUTS.has(type) || type === 'checkbox') own.push(at('control', `<input type=${type}>`))
    else if (type === 'radio') {
      const key = `${sc.file}\u0000${a.name ?? ''}`
      if (sc.state.radios.has(key)) own.push(at('choice', 'radio option past the first'))
      else {
        sc.state.radios.add(key)
        own.push(at('control', 'first radio of a group'))
      }
    } else own.push(at('field', `<input type=${type || 'text'}>`))
    descend = false
  } else if (tag === 'button') own.push(at('control', '<button>'))
  else if (tag === 'component' && RENDERS_CONTROL.test(String(a[':is'] ?? a.is ?? ''))) own.push(at('control', '<component :is>'))
  else if (LINKS.has(tag) && (href || a.onclick || a['@click'])) {
    const origin = ctx.cfg.productOrigins.find((o) => href.startsWith(o))
    own.push(origin ? at('product', `link to ${origin}`) : at('control', `<${tag}>`))
  } else if (CONTROL_ROLES.has(role) && !MEDIA.has(tag)) own.push(at('control', `role=${role}`))

  if (MEDIA.has(tag) || ICON_CLASS.test(cls)) {
    own.push(at('media', `<${tag}>`))
    descend = false
  }
  if (tag === 'section' || tag === 'article' || CARD_CLASS.test(cls)) own.push(at('feature', `<${tag}>`))
  return { own, descend }
}

function i18nItems(ctx, sc, el) {
  const raw = el.attrs.keypath ?? el.attrs[':keypath'] ?? el.attrs.id ?? el.attrs[':id'] ?? ''
  const literal = String(raw).replace(/^[{'"`\s]+|[}'"`\s]+$/g, '')
  const text = ctx.i18n.keyText(literal) ?? ctx.i18n.text(String(raw))
  return [{ unit: 'word', count: text == null ? 1 : wordsIn(text), file: sc.file, line: el.line, note: text == null ? 'unresolved message' : undefined }]
}

// Overlays are off screen until they open: a dialog-like one shows nothing on arrival but its trigger slot, a
// tooltip-like one only the trigger it wraps (its default slot). An `open`/`visible`/`show` set to literal true opens it.
const HIDES_ALL = /(Dialog|Modal|Drawer|Sheet|Snackbar|SnackbarHost|Toast|Toaster)$/
const WRAPS_TRIGGER = /(Tooltip|Popover|Popup|Dropdown|DropdownMenu|ContextMenu|HoverCard)$/
const TRIGGER_SLOT = /^(trigger|activator|reference|anchor)$/
const OPEN_PROPS = ['open', 'visible', 'show', 'modelValue', 'model-value']
const pascal = (tag) => tag.replace(/(^|-)([a-z])/g, (_, _sep, c) => c.toUpperCase())

function overlayKind(tag) {
  const name = pascal(tag)
  if (HIDES_ALL.test(name)) return 'all'
  return WRAPS_TRIGGER.test(name) ? 'trigger' : null
}

const openOnArrival = (a) =>
  OPEN_PROPS.some((p) => [p, `:${p}`, `v-model:${p}`].some((k) => a[k] === true || a[k] === 'true' || a[k] === '{true}'))

function slotName(el) {
  for (const k of Object.keys(el.attrs)) {
    const m = /^(?:#|v-slot:?)([\w-]*)$/.exec(k)
    if (m) return m[1] || 'default'
  }
  return null
}

/** What a closed overlay still shows: its trigger slot, and for a tooltip-like one the default slot it wraps. */
const triggerContent = (el, kind) =>
  el.children.filter((k) => {
    if (k.type !== 'el' || k.tag !== 'template') return kind === 'trigger'
    const name = slotName(k) ?? 'default'
    return TRIGGER_SLOT.test(name) || (kind === 'trigger' && name === 'default')
  })

/** A component tag: its own markup in its file, plus what the caller passes into it (its slots), priced on the caller. */
function renderChild(ctx, sc, child, el, cond) {
  const node = ctx.trace ? { file: child, tag: el.tag, line: el.line, at: sc.file, when: whenOf(el.attrs), points: 0, children: [] } : null
  const done = (items) => {
    if (node) {
      node.points = round(weigh(ctx, items))
      if (node.when === undefined) delete node.when
      sc.tree.push(node)
    }
    return items
  }
  const slotTree = node ? [] : null
  const slotted = collectChildren(ctx, node ? { ...sc, tree: slotTree } : sc, el.children, cond)
  if (sc.depth >= MAX_DEPTH || sc.stack.includes(child)) return done(slotted)
  const t = parsed(ctx, child)
  if (!t) return done(slotted)
  const slots = new Set()
  for (const k of el.children) {
    const name = k.type === 'el' && k.tag === 'template' ? slotName(k) : null
    if (name) slots.add(name)
    else if (k.type === 'el' || wordsIn(k.text) > 0) slots.add('default')
  }
  const look = lookIn(ctx, sc)
  const env = propsOf(el.attrs, (expr) => {
    const v = look(expr)
    return v === undefined && !/^[\w$]+$/.test(expr) ? UNKNOWN : v
  })
  // A component's own markup prices the same wherever it is used with the same slots and the same props its
  // conditions read: priced once per session (per viewport, when it reads a layout flag).
  const base = `${child}|${[...slots].sort().join(',')}|${cond}|${envKey(env, namesRead(ctx, child, t.root))}`
  let own = ctx.owned.get(base) ?? ctx.owned.get(`${base}|${ctx.viewport}`)
  if (own) {
    if (own.sawViewport) ctx.sawViewport = true
  } else {
    const outer = ctx.sawViewport
    ctx.sawViewport = false
    const tree = ctx.trace ? [] : undefined
    const declared = declaredOf(ctx, child)
    const next = { ...sc, file: child, exprs: t.exprs, depth: sc.depth + 1, stack: [...sc.stack, child], slots, tree, env, declared, derived: ctx.derived.get(child) }
    own = { items: collectChildren(ctx, next, t.root.children, cond), tree, sawViewport: ctx.sawViewport }
    ctx.owned.set(own.sawViewport ? `${base}|${ctx.viewport}` : base, own)
    ctx.sawViewport = outer || own.sawViewport
  }
  if (node) node.children.push(...own.tree, ...slotTree)
  return done([...own.items, ...slotted])
}

function measureElement(ctx, sc, el, cond) {
  const tag = el.tag.toLowerCase()
  if (el.tag.startsWith('pc-') || tag === 'script' || tag === 'style') return []
  if ('hidden' in el.attrs || el.attrs['aria-hidden'] === 'true') return []
  if ('v-show' in el.attrs && truthOf(ctx, sc, el.attrs['v-show']) === false) return []
  if (tag === 'i18n-t' || tag === 'formattedmessage') return i18nItems(ctx, sc, el)
  if (tag === 'slot') {
    const name = el.attrs.name ?? (el.attrs[':name'] ? null : 'default')
    const filled = name === null ? sc.slots?.size > 0 : sc.slots?.has(String(name))
    return filled ? [] : collectChildren(ctx, sc, el.children, cond)
  }
  const overlay = overlayKind(el.tag)
  if (overlay && !openOnArrival(el.attrs)) return collectChildren(ctx, sc, triggerContent(el, overlay), cond)
  const child = /[-A-Z]/.test(el.tag) ? ctx.graph.resolveTag(sc.file, el.tag) : null
  if (child) return renderChild(ctx, sc, child, el, cond)
  const { own, descend } = classify(ctx, sc, el, cond)
  return [...own, ...(descend ? collectChildren(ctx, sc, el.children, cond) : [])]
}

/** `$slots.x`, `!$slots.x`, `slots['x']` against the slots the caller fills: true or false, or null when it is not such a test. */
function slotTest(expr, slots) {
  const m = /^\s*(!*)\s*\$?slots(?:\.([\w-]+)|\[\s*['"]([\w-]+)['"]\s*\])\s*$/.exec(String(expr))
  if (!m || !slots) return null
  const has = slots.has(m[2] ?? m[3])
  return m[1].length % 2 ? !has : has
}

function collectChildren(ctx, sc, children, cond) {
  const items = []
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.type === 'text') {
      items.push(...textItems(ctx, sc, node))
      continue
    }
    if (node.tag === 'pc-if') {
      const segments = [[]]
      for (const c of node.children) {
        if (c.tag === 'pc-else') segments.push([])
        else segments[segments.length - 1].push(c)
      }
      // A JSX conditional carries each branch's condition (`when`); a Svelte block carries none and stays unknown.
      const when = Array.isArray(node.attrs.when) ? node.attrs.when : null
      const live = when ? liveBranches(ctx, sc, segments.map((_, k) => when[k] ?? null)) : segments.map((_, k) => k)
      const runs = live.map((k) => (bsc) => collectChildren(ctx, bsc, segments[k], true))
      items.push(...priceBranches(ctx, sc, runs, node.line, segments.length, live.map((k) => k + 1)))
      continue
    }
    if (node.tag === 'pc-each') {
      items.push(...collectChildren(ctx, sc, node.children, cond))
      continue
    }
    if (node.type === 'el' && 'v-if' in node.attrs) {
      const chainAt = (start) => {
        const chain = [children[start]]
        let j = start + 1
        while (j < children.length) {
          const s = children[j]
          if (s.type === 'text' && !s.text.trim()) {
            j++
            continue
          }
          if (s.type === 'el' && ('v-else-if' in s.attrs || 'v-else' in s.attrs)) {
            chain.push(s)
            j++
            continue
          }
          break
        }
        return { chain, end: j }
      }
      let { chain: branches, end } = chainAt(i)
      // A following v-if that can never show together with this chain joins it as one more alternative.
      for (;;) {
        let k = end
        while (k < children.length && children[k].type === 'text' && !children[k].text.trim()) k++
        if (!(k < children.length && children[k].type === 'el' && 'v-if' in children[k].attrs)) break
        const next = chainAt(k)
        if (!exclusive(branches, next.chain)) break
        branches = [...branches, ...next.chain]
        end = next.end
      }
      i = end - 1
      const live = liveBranches(ctx, sc, branches.map((b) => b.attrs['v-if'] ?? b.attrs['v-else-if'] ?? null))
      const runs = live.map((k) => (bsc) => measureElement(ctx, bsc, branches[k], true))
      items.push(...priceBranches(ctx, sc, runs, node.line, branches.length, live.map((k) => k + 1)))
      continue
    }
    items.push(...measureElement(ctx, sc, node, cond))
  }
  return items
}

/**
 * One page or component file priced: { file, points, units, byFile }. A page whose markup tests a phone or desktop
 * layout flag is priced at both and costs its dearer one: { viewport, byViewport: { desktop, phone } } say which.
 */
export function priceFile(ctx, file) {
  const t = parsed(ctx, file)
  if (!t) return { file, points: 0, units: {}, byFile: {}, missing: true }
  const pass = (viewport) => {
    ctx.viewport = viewport
    ctx.sawViewport = false
    const tree = ctx.trace ? [] : undefined
    const sc = { file, exprs: t.exprs, depth: 0, stack: [file], state: { radios: new Set() }, tree, env: null, declared: null }
    const items = collectChildren(ctx, sc, t.root.children, false)
    const priced = { file, ...rollup(items, ctx.list) }
    if (tree) priced.tree = { file, tag: '#page', points: round(weigh(ctx, items)), children: tree }
    return { priced, saw: ctx.sawViewport }
  }
  const desktop = pass('desktop')
  if (!desktop.saw) return desktop.priced
  const phone = pass('phone').priced
  const dearer = phone.points > desktop.priced.points ? phone : desktop.priced
  return { ...dearer, viewport: dearer === phone ? 'phone' : 'desktop', byViewport: { desktop: desktop.priced.points, phone: phone.points } }
}

/** The files a page's markup renders, one level down: resolved component tags, memoised per session. */
function childFiles(ctx, file) {
  if (ctx.children.has(file)) return ctx.children.get(file)
  const out = new Set()
  const visit = (kids) => {
    for (const k of kids) {
      if (k.type !== 'el') continue
      if (/[-A-Z]/.test(k.tag)) {
        const c = ctx.graph.resolveTag(file, k.tag)
        if (c) out.add(c)
      }
      visit(k.children)
    }
  }
  const t = parsed(ctx, file)
  if (t) visit(t.root.children)
  ctx.children.set(file, out)
  return out
}

/** The pages (of the given list) whose markup renders any changed file, directly or through components. */
export function reachingPages(ctx, pages, changed) {
  const hit = []
  for (const p of pages) {
    if (changed.has(p.file)) {
      hit.push(p.file)
      continue
    }
    const seen = new Set([p.file])
    const stack = [p.file]
    let found = false
    while (stack.length && !found) {
      for (const c of childFiles(ctx, stack.pop())) {
        if (changed.has(c)) {
          found = true
          break
        }
        if (!seen.has(c)) {
          seen.add(c)
          stack.push(c)
        }
      }
    }
    if (found) hit.push(p.file)
  }
  return hit
}

/** Pages from discovery (or the given list) priced, most expensive first, each with its route when it has one. */
export function pricePages(ctx, pages) {
  const priced = pages.map((p) => {
    const r = priceFile(ctx, p.file)
    return p.route ? { ...r, route: p.route } : r
  })
  priced.sort((a, b) => b.points - a.points || a.file.localeCompare(b.file))
  return priced
}

export function discoverFor(ctx) {
  return discoverPages(ctx.root, ctx.cfg, ctx.graph.resolveFile, ctx.graph)
}

/** The price of every page in a repo (or of the given pages), most expensive first; `trace` adds each page's render tree. */
export function priceRepo({ root, readFile, pages, trace } = {}) {
  const ctx = session(root, readFile, { trace })
  return { root, mode: 'static', pages: pricePages(ctx, pages ? pages.map((file) => ({ file })) : discoverFor(ctx)) }
}

export const measurePage = (root, file, readFile, { trace } = {}) => priceRepo({ root, readFile, pages: [file], trace }).pages[0]

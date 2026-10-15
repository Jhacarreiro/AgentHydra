// pricecheck/lib/static/measure.mjs - the static measurer: reads a page's markup and every component it renders, and
// emits attributed items (model.mjs) that rollup() turns into the page's price. A component's items belong to the file
// that wrote them, so a page's byFile shares add up to its points.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { OFF_FACTOR, rollup } from '../model.mjs'
import { loadConfig } from '../config.mjs'
import { reachRules } from '../reach.mjs'
import { discoverPages, TEMPLATE_EXT } from './discover.mjs'
import { readTemplate } from './templates.mjs'
import { makeI18n } from './i18n.mjs'
import { makeGraph } from './graph.mjs'
import { UNKNOWN, attrReaders, scriptLiterals, declaredProps, derivedNames, evaluate, openedOrPicked, propsOf, mayStartSet, valueOf, viewportFlag } from './conditions.mjs'

const MAX_DEPTH = 25
const MEDIA = new Set(['img', 'picture', 'video', 'canvas', 'iframe', 'svg', 'object', 'embed'])
const CONTROL_ROLES = new Set(['button', 'tab', 'switch', 'checkbox', 'menuitem', 'link', 'radio'])
const LINKS = new Set(['a', 'router-link', 'routerlink', 'nuxt-link', 'nuxtlink', 'link'])
const RENDERS_CONTROL = /(^|['"`])(button|a|router-link|RouterLink|NuxtLink)(['"`]|$)|\b(RouterLink|NuxtLink)\b/
const BUTTON_INPUTS = new Set(['button', 'submit', 'reset', 'image'])
const ICON_CLASS = /(^|\s)(icon|material-icons|fa-[\w-]+|bi-[\w-]+)(\s|$)/
const CARD_CLASS = /(^|\s)(card|tile)(\s|$)/

export const wordsIn = (s) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length

/** One pricing pass over a repo. `trace: true` also builds each page's render tree (priceFile's `tree`). `share` is another session of the same repo whose config, component graph and catalogs this one reuses (they read the disk, not `readFile`). */
export function session(root, readFile, { trace = false, share } = {}) {
  const cfg = share?.cfg ?? loadConfig(root)
  const graph = share?.graph ?? makeGraph(root, cfg)
  const read =
    readFile ??
    ((f) => {
      graph.reads.add(f)
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
    i18n: share?.i18n ?? makeI18n(root),
    graph,
    reach: reachRules(cfg.reach),
    read,
    cacheable: readFile == null,
    trace,
    templates: new Map(),
    children: new Map(),
    owned: new Map(),
    props: new Map(),
    derived: new Map(),
    initials: new Map(),
    readers: new Map(),
    literals: new Map(),
    names: new Map(),
    outlets: new Map(),
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

const weigh = (ctx, items, page) => items.reduce((s, it) => s + it.count * (ctx.list[it.unit]?.weight ?? 0) * (ctx.reach.reachOf(it, page) === 'off' ? (ctx.cfg.reach.offFactor ?? OFF_FACTOR) : 1), 0)
const round = (n) => Math.round(n * 10) / 10
/** The nearest non-kit file at or above a scope's parent: where a kit component's reach comes from. */
const childVia = (ctx, sc) => (sc.depth > 0 && ctx.reach.isKit(sc.file) ? sc.via : sc.file)
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
    const w = weigh(ctx, items, sc.stack[0])
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
    let p = raw.replace(/\?\./g, '.').replace(/^(props|\$props|this)\./, '').replace(/\.value$/, '')
    const parts = p.split('.')
    if (parts.length > 2 && parts[1] === 'value' && sc.derived?.has(parts[0])) parts.splice(1, 1)
    p = parts.join('.')
    const call = /^([A-Za-z_$][\w$]*)\(\s*['"`]([^'"`]*)['"`]\s*\)$/.exec(raw.trim())
    if (call) return attrCall(ctx, sc, call[1], call[2])
    const [root, ...rest] = parts
    if ((root === '$slots' || root === 'slots') && sc.slots && rest.length === 1) return sc.slots.has(rest[0])
    const env = sc.env
    if (env && Object.hasOwn(env, root)) return member(env[root], rest)
    if (env && !env['...'] && sc.declared?.has(root)) return member(sc.declared.get(root), rest)
    if (sc.derived?.has(p) && depth < 8) {
      depth++
      try {
        return valueOf(sc.derived.get(p), look)
      } finally {
        depth--
      }
    }
    return layout(p)
  }
  return look
}

/** A local attrs-reader called with an attribute name: undefined when the caller sets no such attribute, else UNKNOWN. */
function attrCall(ctx, sc, fn, name) {
  if (!sc.env || sc.env['...'] || !sc.file) return UNKNOWN
  if (!ctx.readers.has(sc.file)) ctx.readers.set(sc.file, attrReaders(ctx.read(sc.file)))
  if (!ctx.readers.get(sc.file).has(fn)) return UNKNOWN
  const key = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
  return Object.hasOwn(sc.env, key) ? UNKNOWN : undefined
}

/**
 * What a script constant passed down holds: a literal `const x = true|false`, or `const x = ref(false)` that no watcher
 * or load hook sets. Else UNKNOWN. Only used for what a caller passes a child, never for the caller's own conditions.
 */
function scriptConstant(ctx, sc, name) {
  if (!sc.file || !/^[A-Za-z_$][\w$]*$/.test(name)) return UNKNOWN
  if (!ctx.literals.has(sc.file)) ctx.literals.set(sc.file, scriptLiterals(ctx.read(sc.file)))
  const lit = ctx.literals.get(sc.file).get(name)
  if (!lit) return UNKNOWN
  if (!lit.ref) return lit.value
  if (!ctx.initials.has(sc.file)) ctx.initials.set(sc.file, mayStartSet(ctx.read(sc.file)))
  return !lit.value && !ctx.initials.get(sc.file).has(name) ? false : UNKNOWN
}

/** A member of a value a prop holds: a key the object lacks is undefined, unless a spread may set it (UNKNOWN). */
function member(value, keys) {
  let v = value
  for (const key of keys) {
    if (v === UNKNOWN) return UNKNOWN
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'object') return UNKNOWN
    if (Object.hasOwn(v, key)) v = v[key]
    else v = v['...'] ? UNKNOWN : undefined
  }
  return v
}

/**
 * Whether a name the component cannot know is closed on arrival: its own state (not a prop) named for something the
 * person opens or picks, which its script does not start as true. Else null (unknown).
 */
const closedOnArrival = (ctx, sc) => (raw) => {
  const p = raw.replace(/\?\./g, '.').replace(/^this\./, '')
  const root = p.split('.')[0]
  if (root === 'props' || root === '$props' || (sc.env && Object.hasOwn(sc.env, root)) || sc.declared?.has(root)) return null
  if (sc.env?.['...'] && !sc.declared) return null
  declaredOf(ctx, sc.file)
  const derivedExpr = (sc.derived ?? ctx.derived.get(sc.file))?.get(p)
  if (derivedExpr !== undefined) {
    // A name derived as "this selection is not empty" is as closed as the selection itself.
    const m = /^\(?\s*([A-Za-z_$][\w$.?]*?)\s*(?:>\s*0|!==?\s*0|>=\s*1)?\s*\)?$/.exec(derivedExpr.trim())
    return m && m[1] !== p ? closedOnArrival(ctx, sc)(m[1]) : null
  }
  if (!openedOrPicked(p)) return null
  if (!ctx.initials.has(sc.file)) ctx.initials.set(sc.file, mayStartSet(ctx.read(sc.file)))
  const last = p.split('.').filter((x) => x !== 'value').pop()
  return ctx.initials.get(sc.file).has(root) || ctx.initials.get(sc.file).has(last) ? null : false
}

/** A condition's truth for this component instance: true, false or null (unknown, priced as possibly shown). */
function truthOf(ctx, sc, expr) {
  const slot = slotTest(expr, sc.slots)
  return slot !== null ? slot : evaluate(expr, lookIn(ctx, sc), closedOnArrival(ctx, sc))
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
    for (const [key, expr] of derived) {
      if (!seen.has(key) && names.has(key.split('.')[0])) {
        seen.add(key)
        add(expr)
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
    return ctx.i18n.text(sc.exprs[+n], sc.file) ?? ' x '
  })
  const count = wordsIn(s)
  const items = count ? [{ unit: 'word', count, file: sc.file, via: sc.via, line: node.line }] : []
  if (icons) items.push({ unit: 'media', count: icons, file: sc.file, via: sc.via, line: node.line, note: 'icon glyph' })
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
  const at = (unit, note) => ({ unit, count: 1, file: sc.file, via: sc.via, line: el.line, note })
  const own = []
  let descend = true

  if (tag === 'option') return { own, descend: false }
  if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') {
    if (!cond && !('v-show' in a)) own.push(at('interruption', 'dialog shown on arrival'))
  }
  if (tag === 'select') {
    own.push(at('field', '<select>'))
    const extra = Math.max(0, countOptions(el) - 1)
    if (extra) own.push({ unit: 'choice', count: extra, file: sc.file, via: sc.via, line: el.line, note: '<option>s past the first' })
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
  const text = ctx.i18n.keyText(literal, sc.file) ?? ctx.i18n.text(String(raw), sc.file)
  return [{ unit: 'word', count: text == null ? 1 : wordsIn(text), file: sc.file, via: sc.via, line: el.line, note: text == null ? 'unresolved message' : undefined }]
}

// Overlays are off screen until they open: a dialog-like one shows nothing on arrival but its trigger slot, a
// tooltip-like one only the trigger it wraps (its default slot). An `open`/`visible`/`show` set to literal true opens it.
const HIDES_ALL = /(Dialog|Modal|Drawer|Sheet|Snackbar|SnackbarHost|Toast|Toaster|Flyout|FlyoutSurface)$/
const SR_ONLY_TAG = /^(?:VisuallyHidden|ScreenReaderOnly|ScreenReader|SrOnly|SROnly)$/
const SR_ONLY_CLASS = /(?:^|\s)(?:sr-only|visually-hidden|screen-reader-only)(?:\s|$)/
const WRAPS_TRIGGER = /(Tooltip|Popover|Popup|Dropdown|DropdownMenu|ContextMenu|HoverCard)$/
const TRIGGER_SLOT = /^(trigger|activator|reference|anchor)$/
const OPEN_PROPS = ['open', 'visible', 'show', 'modelValue', 'model-value']
const pascal = (tag) => tag.replace(/(^|-)([a-z])/g, (_, _sep, c) => c.toUpperCase())

function overlayKind(tag) {
  const name = pascal(tag)
  if (HIDES_ALL.test(name)) return 'all'
  return WRAPS_TRIGGER.test(name) ? 'trigger' : null
}

const RENDERS_WHILE_CLOSED = /renderWhenClosed\s*:\s*true\b/
// A sheet told to keep rendering while closed mounts its slot content on arrival, even though it is hidden.
const openOnArrival = (a) =>
  OPEN_PROPS.some((p) => [p, `:${p}`, `v-model:${p}`].some((k) => a[k] === true || a[k] === 'true' || a[k] === '{true}')) ||
  RENDERS_WHILE_CLOSED.test(a[':behavior'] ?? a.behavior ?? '')

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
      node.points = round(weigh(ctx, items, sc.stack[0]))
      if (node.when === undefined) delete node.when
      sc.tree.push(node)
    }
    return items
  }
  const slotTree = node ? [] : null
  const caller = node ? { ...sc, tree: slotTree } : sc
  if (sc.depth >= MAX_DEPTH || sc.stack.includes(child)) return done(collectChildren(ctx, caller, el.children, cond))
  const t = parsed(ctx, child)
  if (!t) return done(collectChildren(ctx, caller, el.children, cond))
  const slots = new Set()
  for (const k of el.children) {
    const name = k.type === 'el' && k.tag === 'template' ? slotName(k) : null
    if (name) slots.add(name)
    else if (k.type === 'el' || wordsIn(k.text) > 0) slots.add('default')
  }
  const look = lookIn(ctx, sc)
  const env = propsOf(el.attrs, (expr) => {
    let v = look(expr)
    if (v === UNKNOWN) v = scriptConstant(ctx, sc, expr)
    return v === undefined && !/^[\w$]+$/.test(expr) ? UNKNOWN : v
  })
  // A component's own markup prices the same wherever it is used with the same slots and the same props its
  // conditions read: priced once per session (per viewport, when it reads a layout flag).
  // A kit component's reach comes from the non-kit file that rendered it, so its markup is priced once per such file.
  const via = childVia(ctx, sc)
  const kitVia = ctx.reach.isKit(child) ? `|via=${via}` : ''
  const base = `${child}|${[...slots].sort().join(',')}|${cond}|${envKey(env, namesRead(ctx, child, t.root))}${kitVia}`
  let own = ctx.owned.get(base) ?? ctx.owned.get(`${base}|${ctx.viewport}`)
  const outerUses = ctx.uses
  if (own) {
    if (own.sawViewport) ctx.sawViewport = true
  } else {
    const outer = ctx.sawViewport
    ctx.sawViewport = false
    ctx.uses = {}
    const tree = ctx.trace ? [] : undefined
    const declared = declaredOf(ctx, child)
    const reached = new Set()
    const next = { ...sc, file: child, via, exprs: t.exprs, depth: sc.depth + 1, stack: [...sc.stack, child], slots, reached, tree, env, declared, derived: ctx.derived.get(child) }
    own = { items: collectChildren(ctx, next, t.root.children, cond), tree, sawViewport: ctx.sawViewport, reached, uses: ctx.uses }
    ctx.uses = outerUses
    ctx.owned.set(own.sawViewport ? `${base}|${ctx.viewport}` : base, own)
    ctx.sawViewport = outer || own.sawViewport
  }
  if (ctx.uses) {
    ctx.uses[child] = (ctx.uses[child] ?? 0) + 1
    for (const [f, n] of Object.entries(own.uses ?? {})) ctx.uses[f] = (ctx.uses[f] ?? 0) + n
  }
  const slotted = slottedFor(ctx, caller, el, cond, child, own.reached)
  if (node) node.children.push(...own.tree, ...slotTree)
  return done([...own.items, ...slotted])
}

// A slot outlet's name: its static name ('default' when it has none), null when the name is bound.
const outletName = (el) =>
  el.attrs[':name'] !== undefined || el.attrs['v-bind:name'] !== undefined ? null : String(el.attrs.name ?? 'default')

/** The slot outlets a component's markup has: their static names, and whether any is bound (its name unknown). */
function outletsOf(ctx, file) {
  if (!ctx.outlets.has(file)) {
    const names = new Set()
    let dynamic = false
    const walk = (kids) => {
      for (const k of kids) {
        if (k.type !== 'el') continue
        if (k.tag.toLowerCase() === 'slot') {
          const name = outletName(k)
          if (name === null) dynamic = true
          else names.add(name)
        }
        walk(k.children)
      }
    }
    const t = parsed(ctx, file)
    if (t) walk(t.root.children)
    ctx.outlets.set(file, { names, dynamic })
  }
  return ctx.outlets.get(file)
}

/**
 * The caller's content for a component's slots, priced only where the component shows it: content for a slot it reaches,
 * or for a name it has no outlet for, is kept. A component with no outlet at all (JSX children) or a bound one keeps all.
 */
function slottedFor(ctx, sc, el, cond, file, reached) {
  const { names, dynamic } = outletsOf(ctx, file)
  if (dynamic || reached.has('*') || names.size === 0) return collectChildren(ctx, sc, el.children, cond)
  const shows = (name) => reached.has(name) || !names.has(name)
  const items = []
  let run = []
  let runName = null
  const flush = () => {
    if (run.length && shows(runName)) items.push(...collectChildren(ctx, sc, run, cond))
    run = []
  }
  for (const k of el.children) {
    const name = k.type === 'el' && k.tag === 'template' ? (slotName(k) ?? 'default') : 'default'
    if (name !== runName) flush()
    runName = name
    run.push(k)
  }
  flush()
  return items
}

function measureElement(ctx, sc, el, cond) {
  const tag = el.tag.toLowerCase()
  if (el.tag.startsWith('pc-') || tag === 'script' || tag === 'style') return []
  if ('hidden' in el.attrs || el.attrs['aria-hidden'] === 'true') return []
  if (SR_ONLY_CLASS.test(String(el.attrs.class ?? el.attrs.className ?? '')) || SR_ONLY_TAG.test(pascal(el.tag))) return []
  if ('v-show' in el.attrs && truthOf(ctx, sc, el.attrs['v-show']) === false) return []
  if (tag === 'i18n-t' || tag === 'formattedmessage') return i18nItems(ctx, sc, el)
  if (tag === 'slot') {
    const name = outletName(el)
    const filled = name === null ? sc.slots?.size > 0 : sc.slots?.has(name)
    if (!filled) return collectChildren(ctx, sc, el.children, cond)
    sc.reached.add(name ?? '*')
    return []
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
    ctx.uses = {}
    const sc = { file, exprs: t.exprs, depth: 0, stack: [file], state: { radios: new Set() }, tree, env: null, declared: null }
    const items = collectChildren(ctx, sc, t.root.children, false)
    const tagged = items.map((it) => ({ ...it, reach: ctx.reach.reachOf(it, file) }))
    const priced = { file, ...rollup(tagged, ctx.list, { offFactor: ctx.cfg.reach.offFactor ?? OFF_FACTOR, uses: ctx.uses }) }
    if (tree) priced.tree = { file, tag: '#page', points: round(weigh(ctx, items, file)), children: tree }
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

const CONFIG_FILES = ['.pricecheck.json', 'tsconfig.json', 'jsconfig.json']

/** Each file's kit test counts the pages that render it, through any depth of components. */
function countRendered(ctx, files) {
  const rendered = new Map()
  for (const file of files) {
    const seen = new Set()
    const stack = [file]
    while (stack.length) {
      for (const c of childFiles(ctx, stack.pop())) {
        if (seen.has(c)) continue
        seen.add(c)
        stack.push(c)
      }
    }
    for (const c of seen) rendered.set(c, (rendered.get(c) ?? 0) + 1)
  }
  return rendered
}

const statOf = (root, file) => {
  try {
    const s = fs.statSync(path.join(root, file))
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'none'
  }
}

const walkHash = (files) => createHash('sha1').update([...files].sort().join('\n')).digest('hex')

function reachCacheFile(root) {
  const home = process.env.PRICECHECK_HOME || path.join(os.homedir(), '.agenthydra', 'pricecheck')
  return path.join(home, 'reach-cache', `${createHash('sha1').update(path.resolve(root)).digest('hex')}.json`)
}

/** Carries over the one-level child lists of the files that did not move, so an edit recounts only the files it touched. */
function seedChildren(ctx, entry, moved) {
  if (!entry.kids || moved.some((f) => !TEMPLATE_EXT.test(f))) return
  const skip = new Set(moved)
  for (const [f, kids] of Object.entries(entry.kids)) if (!skip.has(f) && !ctx.children.has(f)) ctx.children.set(f, new Set(kids))
}

function readReachCache(ctx) {
  let entry
  try {
    entry = JSON.parse(fs.readFileSync(reachCacheFile(ctx.root), 'utf8'))
  } catch {
    return null
  }
  if (entry.walk !== walkHash(ctx.graph.files)) return null
  const moved = Object.entries(entry.stats)
    .filter(([f, s]) => statOf(ctx.root, f) !== s)
    .map(([f]) => f)
  seedChildren(ctx, entry, moved)
  return moved.length ? null : entry
}

/** The reach cache entry when it still matches the disk, read once per session. */
function cachedReach(ctx) {
  if (!ctx.cacheable) return null
  if (ctx.reachHit === undefined) ctx.reachHit = readReachCache(ctx)
  return ctx.reachHit
}

export const REACH_CACHE_KEEP = 64

/** Keeps only the newest REACH_CACHE_KEEP entries, so the cache does not gain a file for every repo ever priced. */
function pruneReachCache(dir) {
  const entries = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (a.n < b.n ? -1 : 1))
  for (const e of entries.slice(REACH_CACHE_KEEP)) fs.rmSync(path.join(dir, e.n), { force: true })
}

function writeReachCache(ctx, discovered, rendered) {
  const stats = {}
  for (const f of new Set([...ctx.graph.reads, ...CONFIG_FILES, ...ctx.children.keys()])) stats[f] = statOf(ctx.root, f)
  const file = reachCacheFile(ctx.root)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ walk: walkHash(ctx.graph.files), stats, kids: Object.fromEntries([...ctx.children].map(([f, c]) => [f, [...c]])), discovered, rendered: [...rendered] }))
    fs.renameSync(tmp, file)
    pruneReachCache(path.dirname(file))
  } catch {
    /* best effort: without a writable cache the next call recounts */
  }
}

/** Render counts over every discovered page, so a page and a scan of the repo price each page the same way. */
function appWide(ctx) {
  const hit = cachedReach(ctx)
  if (hit) {
    ctx.discovered ??= hit.discovered
    return { discovered: ctx.discovered, reach: reachRules(ctx.cfg.reach, new Map(hit.rendered), hit.discovered.length) }
  }
  const discovered = discoverFor(ctx)
  const rendered = countRendered(ctx, discovered.map((p) => p.file))
  if (ctx.cacheable) writeReachCache(ctx, discovered, rendered)
  return { discovered, reach: reachRules(ctx.cfg.reach, rendered, discovered.length) }
}

export function reachOver(ctx, pages) {
  const { discovered, reach } = appWide(ctx)
  const known = new Set(discovered.map((p) => p.file))
  const extra = pages.map((p) => p.file).filter((f) => !known.has(f))
  if (!extra.length) return reach
  const files = [...known, ...extra]
  return reachRules(ctx.cfg.reach, countRendered(ctx, files), files.length)
}

/** Pages from discovery (or the given list) priced, most expensive first, each with its route when it has one. `reach` lets a ref-side session reuse the working tree's render counts. */
export function pricePages(ctx, pages, reach = reachOver(ctx, pages)) {
  ctx.reach = reach
  const priced = pages.map((p) => {
    const r = priceFile(ctx, p.file)
    return p.route ? { ...r, route: p.route } : r
  })
  priced.sort((a, b) => b.points - a.points || a.file.localeCompare(b.file))
  return priced
}

export function discoverFor(ctx) {
  ctx.discovered ??= cachedReach(ctx)?.discovered ?? discoverPages(ctx.root, ctx.cfg, ctx.graph.resolveFile, ctx.graph)
  return ctx.discovered
}

/** The price of every page in a repo (or of the given pages), most expensive first; `trace` adds each page's render tree. */
export function priceRepo({ root, readFile, pages, trace } = {}) {
  const ctx = session(root, readFile, { trace })
  return { root, mode: 'static', pages: pricePages(ctx, pages ? pages.map((file) => ({ file })) : discoverFor(ctx)) }
}

export const measurePage = (root, file, readFile, { trace } = {}) => priceRepo({ root, readFile, pages: [file], trace }).pages[0]

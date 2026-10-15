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

const MAX_DEPTH = 25
const MEDIA = new Set(['img', 'picture', 'video', 'canvas', 'iframe', 'svg', 'object', 'embed'])
const CONTROL_ROLES = new Set(['button', 'tab', 'switch', 'checkbox', 'menuitem', 'link', 'radio'])
const LINKS = new Set(['a', 'router-link', 'routerlink', 'nuxt-link', 'nuxtlink', 'link'])
const BUTTON_INPUTS = new Set(['button', 'submit', 'reset', 'image'])
const ICON_CLASS = /(^|\s)(icon|material-icons|fa-[\w-]+|bi-[\w-]+)(\s|$)/
const CARD_CLASS = /(^|\s)(card|tile)(\s|$)/

export const wordsIn = (s) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length

export function session(root, readFile) {
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
  return { root, cfg, list: cfg.list, i18n: makeI18n(root), graph: makeGraph(root, cfg), read, templates: new Map(), children: new Map() }
}

function parsed(ctx, file) {
  if (ctx.templates.has(file)) return ctx.templates.get(file)
  const src = ctx.read(file)
  const t = src == null ? null : readTemplate(file, src)
  ctx.templates.set(file, t)
  return t
}

function pickBranch(ctx, branches) {
  let best = []
  let bestW = -1
  for (const b of branches) {
    const w = b.reduce((s, it) => s + it.count * (ctx.list[it.unit]?.weight ?? 0), 0)
    if (w > bestW) {
      best = b
      bestW = w
    }
  }
  return best
}

function textItems(ctx, sc, node) {
  const s = node.text.replace(/\u0001(\d+)\u0002/g, (_, n) => ctx.i18n.text(sc.exprs[+n]) ?? ' x ')
  const count = wordsIn(s)
  return count ? [{ unit: 'word', count, file: sc.file, line: node.line }] : []
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

function renderChild(ctx, sc, child, cond) {
  if (sc.depth >= MAX_DEPTH || sc.stack.includes(child)) return []
  const t = parsed(ctx, child)
  if (!t) return []
  const next = { ...sc, file: child, exprs: t.exprs, depth: sc.depth + 1, stack: [...sc.stack, child] }
  return collectChildren(ctx, next, t.root.children, cond)
}

function measureElement(ctx, sc, el, cond) {
  const tag = el.tag.toLowerCase()
  if (el.tag.startsWith('pc-') || tag === 'script' || tag === 'style') return []
  if ('hidden' in el.attrs || el.attrs['aria-hidden'] === 'true') return []
  if (tag === 'i18n-t' || tag === 'formattedmessage') return i18nItems(ctx, sc, el)
  const child = /[-A-Z]/.test(el.tag) ? ctx.graph.resolveTag(sc.file, el.tag) : null
  if (child) return renderChild(ctx, sc, child, cond)
  const { own, descend } = classify(ctx, sc, el, cond)
  return [...own, ...(descend ? collectChildren(ctx, sc, el.children, cond) : [])]
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
      items.push(...pickBranch(ctx, segments.map((seg) => collectChildren(ctx, sc, seg, true))))
      continue
    }
    if (node.tag === 'pc-each') {
      items.push(...collectChildren(ctx, sc, node.children, cond))
      continue
    }
    if (node.type === 'el' && 'v-if' in node.attrs) {
      const branches = [node]
      let j = i + 1
      while (j < children.length) {
        const s = children[j]
        if (s.type === 'text' && !s.text.trim()) {
          j++
          continue
        }
        if (s.type === 'el' && ('v-else-if' in s.attrs || 'v-else' in s.attrs)) {
          branches.push(s)
          j++
          continue
        }
        break
      }
      i = j - 1
      items.push(...pickBranch(ctx, branches.map((b) => measureElement(ctx, sc, b, true))))
      continue
    }
    items.push(...measureElement(ctx, sc, node, cond))
  }
  return items
}

/** One page or component file priced: { file, points, units, byFile }. */
export function priceFile(ctx, file) {
  const t = parsed(ctx, file)
  if (!t) return { file, points: 0, units: {}, byFile: {}, missing: true }
  const sc = { file, exprs: t.exprs, depth: 0, stack: [file], state: { radios: new Set() } }
  const items = collectChildren(ctx, sc, t.root.children, false)
  return { file, ...rollup(items, ctx.list) }
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
  return discoverPages(ctx.root, ctx.cfg, ctx.graph.resolveFile)
}

/** The price of every page in a repo (or of the given pages), most expensive first. */
export function priceRepo({ root, readFile, pages } = {}) {
  const ctx = session(root, readFile)
  return { root, mode: 'static', pages: pricePages(ctx, pages ? pages.map((file) => ({ file })) : discoverFor(ctx)) }
}

export const measurePage = (root, file, readFile) => priceRepo({ root, readFile, pages: [file] }).pages[0]

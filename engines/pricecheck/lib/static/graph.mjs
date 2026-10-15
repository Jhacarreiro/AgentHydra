// pricecheck/lib/static/graph.mjs - which file a component tag in a template renders: imports, index re-exports,
// lazy components, the Vue components option, tsconfig/jsconfig paths, vite aliases, and auto-registered components.
import fs from 'node:fs'
import path from 'node:path'
import { walk, exists } from './discover.mjs'

const EXTS = ['.vue', '.svelte', '.tsx', '.jsx', '.ts', '.js', '.mjs', '.astro']
const RE_IMPORT = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const RE_LAZY = /(?:const|let|var)\s+(\w+)\s*=\s*(?:defineAsyncComponent|lazy|React\.lazy)\(\s*\(\s*\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g
const RE_EXPORT_FROM = /export\s*(\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/g
const RE_COMPONENTS = /components\s*:\s*\{([^}]*)\}/g
const COMPONENT_FILE = /\.(vue|svelte|tsx|jsx)$/
const RE_DEFINES =/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g

const pascal = (tag) => tag.split(/[-.]/).map((p) => p[0].toUpperCase() + p.slice(1)).join('')
const baseName = (file) => file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')

function stripJsonc(text) {
  return text.replace(/(^|[\s,{[])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')
}

function readAliases(root) {
  const out = []
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let cfg
    try {
      cfg = JSON.parse(stripJsonc(fs.readFileSync(path.join(root, name), 'utf8')))
    } catch {
      continue
    }
    const co = cfg.compilerOptions ?? {}
    const base = co.baseUrl ?? '.'
    for (const [key, targets] of Object.entries(co.paths ?? {})) {
      const target = targets[0]
      if (!target) continue
      out.push({ prefix: key.replace(/\/\*$/, ''), to: path.posix.normalize(path.posix.join(base, target.replace(/\/\*$/, ''))) })
    }
    break
  }
  return out
}

/** Names bound by an import clause: default, { a as b, c }, * as ns. */
function importedNames(clause) {
  const names = []
  const c = clause.replace(/^type\s+/, '')
  const brace = /\{([^}]*)\}/.exec(c)
  const head = c.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()
  if (head && !head.startsWith('*')) names.push({ local: head, exported: 'default' })
  if (head.startsWith('*')) {
    const ns = /\*\s*as\s+(\w+)/.exec(head)
    if (ns) names.push({ local: ns[1], exported: '*' })
  }
  if (brace) {
    for (const part of brace[1].split(',')) {
      const m = /^\s*(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part)
      if (m) names.push({ local: m[2] ?? m[1], exported: m[1] })
    }
  }
  return names
}

export function makeGraph(root, cfg = {}) {
  const files = new Set(walk(root))
  const aliases = [...(cfg.alias ? Object.entries(cfg.alias).map(([prefix, to]) => ({ prefix, to })) : []), ...readAliases(root)]
  const byName = new Map()
  for (const f of files) {
    if (/(^|\/)components\//.test(f) && /\.(vue|svelte|tsx|jsx)$/.test(f) && !byName.has(baseName(f))) byName.set(baseName(f), f)
  }
  const fileCache = new Map()
  const tagCache = new Map()
  const reads = new Set()

  const gone = new Map()
  const present = (c) => {
    if (!files.has(c)) return false
    if (!gone.has(c)) gone.set(c, !exists(root, c))
    return !gone.get(c)
  }

  function resolveFile(spec, from) {
    let base = null
    if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
    else {
      for (const a of aliases) {
        if (spec === a.prefix || spec.startsWith(`${a.prefix}/`)) {
          base = path.posix.normalize(path.posix.join(a.to, spec.slice(a.prefix.length + 1)))
          break
        }
      }
    }
    if (base === null) return null
    base = base.replace(/^\.\//, '')
    const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)]
    return candidates.find(present) ?? null
  }

  function scriptOf(file) {
    if (fileCache.has(file)) return fileCache.get(file)
    reads.add(file)
    let text = ''
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      /* unreadable: no imports */
    }
    const info = { imports: new Map(), lazy: new Map(), options: new Map(), exports: new Map(), defines: new Set() }
    for (const m of text.matchAll(RE_DEFINES)) info.defines.add(m[1])
    for (const m of text.matchAll(RE_IMPORT)) {
      const target = resolveFile(m[2], file)
      if (!target) continue
      for (const n of importedNames(m[1])) info.imports.set(n.local, { target, exported: n.exported })
    }
    for (const m of text.matchAll(RE_LAZY)) {
      const target = resolveFile(m[2], file)
      if (target) info.lazy.set(m[1], target)
    }
    for (const m of text.matchAll(RE_COMPONENTS)) {
      for (const part of m[1].split(',')) {
        const pm = /^\s*(\w+)(?:\s*:\s*(\w+))?\s*$/.exec(part)
        if (pm) info.options.set(pm[1], pm[2] ?? pm[1])
      }
    }
    for (const m of text.matchAll(RE_EXPORT_FROM)) {
      const target = resolveFile(m[3], file)
      if (!target) continue
      if (m[1] === '*') info.exports.set('*', target)
      else for (const part of m[2].split(',')) {
        const em = /^\s*(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part)
        if (em) info.exports.set(em[2] ?? em[1], { target, exported: em[1] })
      }
    }
    fileCache.set(file, info)
    return info
  }

  /** The file a name exported from `file` comes from, following index re-exports (depth-capped). */
  function exportedFrom(file, name, depth = 0) {
    if (depth > 10) return null
    const info = scriptOf(file)
    const e = info.exports.get(name)
    if (e && typeof e === 'object') return e.exported === 'default' ? e.target : exportedFrom(e.target, e.exported, depth + 1)
    if (info.exports.has('*')) {
      const found = exportedFrom(info.exports.get('*'), name, depth + 1)
      if (found) return found
    }
    return info.defines.has(name) && COMPONENT_FILE.test(file) ? file : null
  }

  /** The file a component tag in `from` renders, or null for a tag no file in the repo defines (a native element or a library component). */
  function resolveTag(from, tag) {
    const key = `${from}\u0000${tag}`
    if (tagCache.has(key)) return tagCache.get(key)
    const info = scriptOf(from)
    const pas = pascal(tag)
    let found = null
    const local = info.options.get(pas) ?? info.options.get(tag) ?? pas
    if (info.lazy.has(local)) found = info.lazy.get(local)
    else if (info.imports.has(local)) {
      const { target, exported } = info.imports.get(local)
      found = exported === 'default' ? target : exportedFrom(target, exported)
    } else if (byName.has(pas) && present(byName.get(pas))) found = byName.get(pas)
    tagCache.set(key, found)
    return found
  }

  return { resolveTag, resolveFile, files, reads }
}

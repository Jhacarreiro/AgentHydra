// pricecheck/lib/static/i18n.mjs - the English catalogs, so a translated key counts the words a person reads.
import fs from 'node:fs'
import path from 'node:path'
import { walk } from './discover.mjs'

const CATALOG_FOLDERS = new Set(['locales', 'locale', 'i18n', 'lang', 'messages'])
const SOURCE = /\.(json|[cm]?[jt]s)$/
const TEST_OR_TYPES = /\.(test|spec)\.[^/]+$|\.d\.ts$|(^|\/)(__tests__|__mocks__|__fixtures__|tests?|fixtures?)\//
const EN = /^en(-[A-Za-z]+)?$/
const TRANSLATORS = new Set(['t', 'tc', 'tr', 'T', 'trPlural', '$t', '$tc', 'translate', 'formatMessage'])
const CALL = /(?<![\w$])([\w$]+)\(\s*(['"`])([^'"`$]+)\2/g
const FORMAT_ID = /\bformatMessage\(\s*\{\s*id:\s*(['"`])([^'"`$]+)\1/g
const WORD = /[\w$]+/y
const ESCAPES = { n: '\n', t: '\t', r: '\r' }
const isTranslator = (name) => TRANSLATORS.has(name) || /(?:[a-z\d]T|Tr)$/.test(name)

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else if (typeof v === 'string') out.set(key, v)
  }
  return out
}

function tokenize(src) {
  const out = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      i = end < 0 ? n : end
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let from = j
      let v = ''
      let tpl = false
      while (j < n && src[j] !== c && (c === '`' || src[j] !== '\n')) {
        if (src[j] === '\\') {
          v += src.slice(from, j) + (ESCAPES[src[j + 1]] ?? src[j + 1] ?? '')
          j += 2
          from = j
          continue
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') tpl = true
        j++
      }
      v += src.slice(from, Math.min(j, n))
      out.push({ k: 's', v, closed: src[j] === c, tpl })
      i = j + 1
    } else if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || /\s/.test(c)) {
      i++
    } else {
      WORD.lastIndex = i
      const m = WORD.exec(src)
      if (m) {
        out.push({ k: 'i', v: m[0] })
        i += m[0].length
      } else {
        out.push({ k: 'p', v: c })
        i++
      }
    }
  }
  return out
}

const isP = (t, c) => t?.k === 'p' && t.v === c

function skipEntry(toks, i) {
  let depth = 0
  for (; i < toks.length; i++) {
    const t = toks[i]
    if (t.k !== 'p') continue
    if ('([{'.includes(t.v)) depth++
    else if (')]}'.includes(t.v)) {
      if (t.v === '}' && depth === 0) return i
      if (depth > 0) depth--
    } else if (t.v === ',' && depth === 0) return i
  }
  return i
}

function endsValue(toks, k) {
  while (toks[k]?.k === 'i' && (toks[k].v === 'as' || toks[k].v === 'const')) k++
  return toks[k] === undefined || isP(toks[k], ',') || isP(toks[k], '}')
}

function readObject(toks, i, prefix, leaves) {
  i++
  while (i < toks.length && !isP(toks[i], '}')) {
    const t = toks[i]
    if (isP(t, ',') || isP(t, ';')) {
      i++
      continue
    }
    if (!(t.k === 's' || t.k === 'i') || !isP(toks[i + 1], ':')) {
      i = skipEntry(toks, i)
      continue
    }
    const key = prefix ? `${prefix}.${t.v}` : t.v
    const value = toks[i + 2]
    if (isP(value, '{')) i = readObject(toks, i + 2, key, leaves)
    else {
      if (value?.k === 's' && value.closed && !value.tpl && endsValue(toks, i + 3)) leaves.set(key, value.v)
      i += 2
    }
    i = skipEntry(toks, i)
  }
  return i + 1
}

const startsObject = (t) => t !== undefined && (isP(t, '=') || isP(t, '(') || (t.k === 'i' && t.v === 'default'))

function moduleLeaves(src) {
  const toks = tokenize(src)
  const leaves = new Map()
  for (let i = 0; i < toks.length; i++) {
    if (isP(toks[i], '{') && startsObject(toks[i - 1])) i = readObject(toks, i, '', leaves) - 1
  }
  return leaves
}

function jsonLeaves(src) {
  const data = JSON.parse(src)
  return data && typeof data === 'object' ? flatten(data, '', new Map()) : new Map()
}

/** The namespace of an English catalog file ('' for a file at the catalog root), or undefined when it is not one. */
function englishNamespace(file) {
  if (!SOURCE.test(file) || TEST_OR_TYPES.test(file)) return undefined
  const parts = file.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    if (!CATALOG_FOLDERS.has(parts[i]) || !EN.test(parts[i + 1].replace(SOURCE, ''))) continue
    if (i + 1 === parts.length - 1) return ''
    const rest = parts.slice(i + 2)
    rest[rest.length - 1] = rest[rest.length - 1].replace(SOURCE, '')
    return rest.join('.')
  }
  return undefined
}

const words = (s) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length

/** The English text as a reader sees it: the longest plural form, each {placeholder} a word of its own. */
function displayText(raw) {
  const form = raw.includes('|') ? raw.split(/\s*\|\s*/).reduce((best, f) => (words(f) > words(best) ? f : best)) : raw
  return (form.includes('{') ? form.replace(/\{[^{}]*\}/g, ' $& ') : form).replace(/\s+/g, ' ').trim()
}

const add = (map, key, entry) => {
  const list = map.get(key)
  if (list) list.push(entry)
  else map.set(key, [entry])
}

function indexEntries(entries) {
  const byKey = new Map()
  const bySuffix = new Map()
  for (const e of entries) {
    add(byKey, e.key, e)
    const parts = e.key.split('.')
    for (let i = 0; i < parts.length; i++) add(bySuffix, parts.slice(i).join('.'), e)
  }
  return { byKey, bySuffix }
}

/** The English catalog of the repo: every key (namespace-prefixed) plus its bare leaf path, indexed for lookup. */
export function loadCatalog(root) {
  const entries = []
  for (const file of walk(root)) {
    const ns = englishNamespace(file)
    if (ns === undefined) continue
    let leaves
    try {
      const src = fs.readFileSync(path.join(root, file), 'utf8')
      leaves = file.endsWith('.json') ? jsonLeaves(src) : moduleLeaves(src)
    } catch {
      continue
    }
    for (const [key, text] of leaves) entries.push({ key: ns ? `${ns}.${key}` : key, file, text: displayText(text) })
  }
  return indexEntries(entries)
}

/** Every message key an expression refers to, in the order they appear. */
export function keysIn(expr) {
  const found = []
  for (const m of expr.matchAll(CALL)) if (isTranslator(m[1])) found.push({ at: m.index, key: m[3] })
  for (const m of expr.matchAll(FORMAT_ID)) found.push({ at: m.index, key: m[2] })
  return found.sort((a, b) => a.at - b.at).map((f) => f.key)
}

const shared = (a, b) => {
  const x = a.split('/')
  const y = b.split('/')
  let n = 0
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++
  return n
}

function lookup(index, key, fromFile) {
  const hits = index.byKey.get(key) ?? index.bySuffix.get(key)
  if (!hits) return null
  if (fromFile === undefined) return hits[0].text
  return hits.reduce((best, e) => (shared(e.file, fromFile) > shared(best.file, fromFile) ? e : best)).text
}

/** Builds the resolver for one repo: text(expr, fromFile) -> the English text an expression shows, or null when no key resolves. */
export function makeI18n(root) {
  const index = loadCatalog(root)
  const keyText = (key, fromFile) => lookup(index, key, fromFile)
  return {
    keyText,
    text(expr, fromFile) {
      const parts = keysIn(expr).map((key) => keyText(key, fromFile))
      return parts.every((p) => p !== null) && parts.length ? parts.join(' ') : null
    },
  }
}

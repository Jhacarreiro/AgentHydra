// pricecheck/lib/static/i18n.mjs - the English catalog, so a translated key counts the words a person reads.
import fs from 'node:fs'
import path from 'node:path'
import { walk } from './discover.mjs'

const CATALOG_DIRS = ['locales', 'i18n', 'lang', 'messages', 'src/locales', 'src/i18n', 'src/lang', 'src/messages', 'public/locales']
const EN_FILE = /(^|\/)en(-[A-Za-z]+)?\.json$/
const EN_NAMESPACE = /(^|\/)en(-[A-Za-z]+)?\/(.+)\.json$/
const CALLS = [
  /(?:^|[^\w$.])\$?t\(\s*(['"`])([^'"`$]+)\1/g,
  /\bi18n\.t\(\s*(['"`])([^'"`$]+)\1/g,
  /\bformatMessage\(\s*\{\s*id:\s*(['"`])([^'"`$]+)\1/g,
  /\bformatMessage\(\s*(['"`])([^'"`$]+)\1/g,
]

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else if (typeof v === 'string') out.set(key, v)
  }
  return out
}

/** The English strings of every catalog under the repo: key (dotted) -> text. A namespace folder prefixes its keys. */
export function loadCatalog(root) {
  const out = new Map()
  for (const file of walk(root)) {
    const dir = CATALOG_DIRS.find((d) => file.startsWith(`${d}/`))
    if (!dir || !file.endsWith('.json')) continue
    let prefix = null
    if (EN_NAMESPACE.test(file)) prefix = EN_NAMESPACE.exec(file)[3].replace(/\//g, '.')
    else if (!EN_FILE.test(file)) continue
    let data
    try {
      data = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    } catch {
      continue
    }
    if (data && typeof data === 'object') flatten(data, prefix, out)
  }
  return out
}

/** Every message key an expression or element refers to. */
export function keysIn(expr) {
  const keys = []
  for (const re of CALLS) {
    re.lastIndex = 0
    for (const m of expr.matchAll(re)) keys.push(m[2])
  }
  return keys
}

/** Builds the resolver for one repo: text(expr) -> the English text an expression shows, or null when no key resolves. */
export function makeI18n(root) {
  const catalog = loadCatalog(root)
  const keyText = (key) => catalog.get(key) ?? null
  return {
    catalog,
    keyText,
    text(expr) {
      const parts = keysIn(expr).map(keyText)
      return parts.every((p) => p !== null) && parts.length ? parts.join(' ') : null
    },
  }
}

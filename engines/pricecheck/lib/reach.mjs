// pricecheck/lib/reach.mjs - whether a priced item is about the page it sits on (own) or about something else (off).
// Kit (a shared building block) is never a reach of its own: it takes the reach of the non-kit file that rendered it.

const KIT_FOLDERS = new Set(['ui', 'kit', 'base', 'common', 'shared', 'primitives', 'design-system', 'layout', 'layouts'])

const KIT_FOLDER_SUFFIX = /-(ui|kit|components|primitives|design-system)$/

const GENERIC = new Set([
  'src', 'app', 'apps', 'views', 'view', 'pages', 'page', 'components', 'component', 'index', 'list', 'detail', 'details',
  'panel', 'card', 'dialog', 'modal', 'sheet', 'section', 'item', 'row', 'base', 'main', 'root',
  'routes', 'route', 'lib', 'utils', 'assets', 'styles', 'hooks', 'stores', 'store', 'composables', 'plugins',
  'services', 'service', 'packages', 'package', 'web',
])

const norm = (file) => String(file ?? '').replace(/\\/g, '/')

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const globToRegExp = (glob) => new RegExp(`^${glob.split('**').map((p) => p.split('*').map(esc).join('[^/]*')).join('.*')}$`)

const matches = (globs, file) => (globs ?? []).some((g) => globToRegExp(g).test(file))

const singular = (w) => (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

/** The words that say what a file is about: folder and file names split on case and punctuation, generic words and words under 3 letters dropped. */
export function featureWords(file) {
  const words = norm(file)
    .replace(/\.[^./]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => singular(w.toLowerCase()))
  return new Set(words.filter((w) => w.length >= 3 && !GENERIC.has(w)))
}

const dirOf = (file) => file.slice(0, file.lastIndexOf('/') + 1)

/**
 * cfg: { own, off, kit } glob lists from .pricecheck.json. rendered: file -> how many pages render it. pages: how many pages there are.
 * Returns { reachOf(item, pageFile), isKit(file) }. An item is { unit, file, via? } where via is the nearest non-kit file that rendered it.
 */
export function reachRules(cfg = {}, rendered = new Map(), pages = 0) {
  const isKit = (file) => {
    const f = norm(file)
    if (matches(cfg.kit, f)) return true
    const folders = f.split('/').slice(0, -1)
    if (folders.some((d) => KIT_FOLDERS.has(d) || KIT_FOLDER_SUFFIX.test(d))) return true
    const n = rendered.get(f) ?? 0
    return n >= 3 && n * 5 >= pages
  }

  const words = new Map()
  const wordsOf = (file) => {
    if (!words.has(file)) words.set(file, featureWords(file))
    return words.get(file)
  }

  const sharesPage = (file, page) => {
    if (file.startsWith(dirOf(page))) return true
    const mine = wordsOf(page)
    for (const w of wordsOf(file)) if (mine.has(w)) return true
    return false
  }

  const reachOf = (item, page) => {
    if (item.unit === 'product') return 'off'
    const file = norm(item.file)
    if (!file || file === '(page)' || file === norm(page)) return 'own'
    if (matches(cfg.own, file)) return 'own'
    if (matches(cfg.off, file)) return 'off'
    if (isKit(file)) return item.via ? reachOf({ file: item.via }, page) : 'own'
    return sharesPage(file, norm(page)) ? 'own' : 'off'
  }

  return { reachOf, isKit }
}

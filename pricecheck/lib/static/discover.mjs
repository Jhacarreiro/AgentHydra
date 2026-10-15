// pricecheck/lib/static/discover.mjs - which files are pages: the repo's "pages" globs, else router evidence and file-name conventions.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TEMPLATE_EXT = /\.(vue|svelte|html|htm|astro|tsx|jsx)$/
const SOURCE_EXT = /\.(vue|svelte|tsx|jsx|ts|js|mjs)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'tmp', '.git', '.next', '.nuxt', '.svelte-kit', 'cdk.out', 'target'])
const ROUTER_FILE = /(^|\/)(router|routes?|routing|app|main|index|App|root|entry)[^/]*\.(vue|tsx|jsx|ts|js|mjs)$/i
const ROUTER_HINT = /createRouter|createBrowserRouter|createWebHistory|createMemoryHistory|<Route\b|RouterProvider|useRoutes|component:\s*(\(|[A-Z])/
const TEST_OR_STORY = /\.(test|spec|stories|story)\.[a-z]+$|(^|\/)(__tests__|__mocks__|__fixtures__|tests?|fixtures?|e2e)\//
const ENTRY_FILE = /(^|\/)(main|index|entry|client|app|root)\.(ts|tsx|js|jsx|mjs)$/i
const MOUNT = /createApp\(\s*(\w+)|\.render\(\s*<(\w+)|\bmount\(\s*(\w+)\s*,\s*\{\s*target|new\s+(\w+)\(\s*\{\s*target/g
const HOSTS_ROUTER = /<RouterView\b|<router-view\b|<Routes\b|<RouterProvider\b|<Outlet\b|<Switch\b/
const CONVENTION = [
  /(^|\/)(views|pages)\/.+\.(vue|svelte|tsx|jsx)$/,
  /(^|\/)[^/]*(Page|View)\.(vue|svelte|tsx|jsx)$/,
]
const NOT_PAGE = /NodeView\./

/** A glob (** * ?) as a RegExp over a posix relative path. */
export function globToRe(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const walked = new Map()
const skipped = (rel) => rel.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d) || d.startsWith('.'))

/** Files git sees under root (tracked plus untracked, minus ignored and deleted), or null outside a git work tree. */
function gitFiles(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return null
    const list = (...flags) => git('ls-files', '-z', ...flags).split('\0').filter(Boolean)
    const deleted = new Set(list('--deleted'))
    return [...new Set(list('--cached', '--others', '--exclude-standard'))].filter((f) => !deleted.has(f) && !skipped(f))
  } catch {
    return null
  }
}

/**
 * Every file under root as a posix relative path, skipping what the repo gitignores, build output, dependencies and
 * hidden folders. Memoised per root.
 */
export function walk(root) {
  if (walked.has(root)) return walked.get(root)
  const listed = gitFiles(root)
  if (listed) {
    listed.sort()
    walked.set(root, listed)
    return listed
  }
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(r)
      } else if (e.isFile()) out.push(r)
    }
  }
  out.sort()
  walked.set(root, out)
  return out
}

const read = (root, file) => {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8')
  } catch {
    return ''
  }
}

const segments = (dir) => dir.split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
const routeOf = (segs) => {
  const r = `/${segs.join('/')}`.replace(/\/index$/, '')
  return r || '/'
}

/** The route a file-routed page answers at (Next app/pages, Nuxt pages, SvelteKit routes), or undefined. */
export function fileRoute(file) {
  let m = /(?:^|\/)app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js)$/.exec(file)
  if (m) return routeOf(segments(m[1] ?? ''))
  m = /(?:^|\/)src\/routes\/(.*)\/\+page\.svelte$/.exec(file)
  if (m) return routeOf(segments(m[1]))
  m = /(?:^|\/)pages\/(.+)\.(?:vue|svelte|tsx|jsx)$/.exec(file)
  if (m && !/(^|\/)_/.test(m[1])) return routeOf(segments(m[1]))
  return undefined
}

const importsOf = (src) => {
  const map = new Map()
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) map.set(m[1], m[2])
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:\(\s*\)\s*=>\s*)?(?:lazy|defineAsyncComponent)?\(?\s*\(\s*\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g)) map.set(m[1], m[2])
  return map
}

/** Router records in a source file: [{ route, spec }] where spec is the component's import specifier. */
function routeRecords(src) {
  const out = []
  const imports = importsOf(src)
  const specOf = (ident) => (ident ? imports.get(ident) : undefined)
  for (const m of src.matchAll(/path:\s*['"`]([^'"`]*)['"`][^{}]*?component:\s*(?:\(\s*\)\s*=>\s*import\(\s*['"`]([^'"`]+)['"`]\s*\)|(\w+))/g)) {
    const spec = m[2] ?? specOf(m[3])
    if (spec) out.push({ route: m[1], spec })
  }
  for (const m of src.matchAll(/<Route\b[^>]*?path=\{?['"`]([^'"`]+)['"`][^>]*?element=\{\s*<(\w+)/g)) {
    const spec = specOf(m[2])
    if (spec) out.push({ route: m[1], spec })
  }
  for (const m of src.matchAll(/path:\s*['"`]([^'"`]*)['"`]\s*,\s*element:\s*<(\w+)/g)) {
    const spec = specOf(m[2])
    if (spec) out.push({ route: m[1], spec })
  }
  return out
}

/**
 * Pages under root as [{ file, route? }]: the config's `pages` globs when set; otherwise router evidence (route records,
 * file-based routing) unioned with the file-name conventions. Ignored and test files never count.
 * `resolve(spec, fromFile)` maps an import specifier to a repo file (aliases included), or null.
 */
export function discoverPages(root, cfg = {}, resolve = () => null) {
  const ignore = (cfg.ignore ?? []).map(globToRe)
  const files = walk(root)
  const usable = (f) => TEMPLATE_EXT.test(f) && !TEST_OR_STORY.test(f) && !ignore.some((re) => re.test(f))
  const found = new Map()
  const add = (file, route) => {
    if (!found.has(file) || (route && !found.get(file))) found.set(file, route)
  }

  if (cfg.pages?.length) {
    const include = cfg.pages.map(globToRe)
    for (const f of files) if (usable(f) && include.some((re) => re.test(f))) add(f)
    return [...found].map(([file, route]) => (route ? { file, route } : { file }))
  }

  for (const f of files) {
    if (!usable(f)) continue
    const route = fileRoute(f)
    if (route !== undefined) add(f, route)
  }
  for (const f of files) {
    if (!ROUTER_FILE.test(f) || !SOURCE_EXT.test(f) || TEST_OR_STORY.test(f)) continue
    const src = read(root, f)
    if (ROUTER_HINT.test(src)) {
      for (const { route, spec } of routeRecords(src)) {
        const target = resolve(spec, f)
        if (target && usable(target)) add(target, route)
      }
    }
    // A single-screen app: the root component the entry mounts is the page, unless it only hosts a router's screens.
    if (!ENTRY_FILE.test(f)) continue
    const imports = importsOf(src)
    for (const m of src.matchAll(MOUNT)) {
      const spec = imports.get(m[1] ?? m[2] ?? m[3] ?? m[4])
      const target = spec && resolve(spec, f)
      if (target && usable(target) && !HOSTS_ROUTER.test(read(root, target))) add(target, '/')
    }
  }
  for (const f of files) {
    if (!usable(f)) continue
    if (/\.(html|htm)$/.test(f)) {
      if (/<body[\s>]/i.test(read(root, f))) add(f)
    } else if (CONVENTION.some((re) => re.test(f)) && !NOT_PAGE.test(f)) add(f)
  }
  return [...found].map(([file, route]) => (route ? { file, route } : { file }))
}

/** Whether a file would be a page by name or route alone (no fs read): tells a deleted page from any deleted file. */
export function isPageFile(file) {
  if (!TEMPLATE_EXT.test(file) || TEST_OR_STORY.test(file)) return false
  if (/\.(html|htm)$/.test(file)) return true
  return fileRoute(file) !== undefined || (CONVENTION.some((re) => re.test(file)) && !NOT_PAGE.test(file))
}

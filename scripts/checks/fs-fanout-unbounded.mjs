// Guardrail against an unbounded fan-out of async filesystem calls in a Bun process.
//
// THE FAILURE (2026-10-16): Bun runs every async fs call on a thread of its I/O pool, starts a new thread
// whenever all are busy, and never gives one back (~6.6 MB each; server/src/core/fs-slots.ts has the
// measurements). 44429d00 made Desk read a message's pictures one at a time for that reason, and two days
// later e5382243 put `Promise.all(images.map(async ... readFile ...))` straight back into the same
// function (desk2/server/src/engine/queue.ts readBack). The bridge's codexTurns had the same shape. Both
// were found only by a sweep; nothing stopped them landing.
//
// THE RULE: never `Promise.all(xs.map(...))` (or allSettled) over async fs calls. A list sized by data
// starts one I/O thread per item, held for the process's life. Either read one at a time
// (`for (const x of xs) out.push(await readFile(x))`), or take a slot per call from the shared
// ceiling: `Promise.all(xs.map((x) => fsSlot(() => readFile(x))))` (server/src/core/fs-slots.ts).
//
// DELIBERATELY NOT FLAGGED: a fixed list (`Promise.all([readFile(a), stat(b)])`) is bounded by the
// code, not the data; sync calls (readFileSync) run on the caller's thread. A fan-out whose list is
// bounded by construction can say so on the line before the call: `// fanout-ok: <why it is bounded>`.
//
// Self-contained by design, like its siblings here: node stdlib only, plain finding objects.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'fs-fanout-unbounded'
// The Bun processes: the daemon, the Desk server, Hydra Core and the orchestrator's server. The windows
// (desk2/web, desk2/hydra) run in a browser, where fs is not a thing.
const ROOTS = ['server/src', 'desk2/server/src', 'core/src', 'hydra-core', 'orchestrator/server/src']
const SOURCE = /\.(ts|tsx|mts|mjs|js)$/
const SKIP_DIR = new Set(['node_modules', 'dist', 'tests', 'test', '__tests__', 'fixtures'])
const SKIP_FILE = /\.(test|spec)\.[a-z]+$|\.d\.ts$/
const FS_CALLS =
  'readFile|writeFile|appendFile|readdir|stat|lstat|access|open|opendir|rm|rmdir|unlink|mkdir|copyFile|cp|rename|realpath|readlink|utimes|chmod|truncate'
// A Bun file read or write: Bun.file(p).text() and friends, Bun.write(...).
const BUN_IO = /\bBun\s*\.\s*(write\s*\(|file\s*\([^)]*\)\s*\.\s*(text|json|arrayBuffer|bytes|exists|stat)\s*\()/

/** One line's code: a line comment cut, the inside of string literals blanked to spaces (so offsets
 *  still match). Line by line on purpose: a regex literal holding a quote, or a template string over
 *  several lines, then confuses one line, never the rest of the file. */
function lineCode(line) {
  let out = ''
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') {
        out += '  '
        i++
      } else if (ch === quote) {
        quote = null
        out += ch
      } else out += ' '
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    out += ch
  }
  return out
}

/** The text with comments and string contents blanked, line for line. */
export function codeOnly(text) {
  let inBlock = false
  return text
    .split('\n')
    .map((raw) => {
      let line = raw
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end < 0) return ''
        line = ' '.repeat(end + 2) + line.slice(end + 2)
        inBlock = false
      }
      line = line.replace(/\/\*.*?\*\//g, (m) => ' '.repeat(m.length))
      const start = line.indexOf('/*')
      if (start >= 0) {
        inBlock = true
        line = line.slice(0, start)
      }
      return lineCode(line)
    })
    .join('\n')
}

/** The names this file imports from node:fs/promises (and the namespace it binds, if any). */
function fsPromiseNames(text) {
  const names = new Set()
  const spaces = new Set()
  // No quote inside the clause: this repo writes no semicolons, so the clause must stop at the
  // previous import's `from '...'` rather than run on across it.
  const rx = /import\s+([^;'"]*?)\s+from\s+['"](?:node:)?fs\/promises['"]/g
  for (const m of text.matchAll(rx)) {
    const clause = m[1]
    const ns = /\*\s+as\s+(\w+)/.exec(clause)
    if (ns) spaces.add(ns[1])
    const def = /^(\w+)\s*(,|$)/.exec(clause.trim())
    if (def) spaces.add(def[1])
    const braces = /\{([^}]*)\}/.exec(clause)
    if (braces)
      for (const part of braces[1].split(',')) {
        const [orig, alias] = part.trim().split(/\s+as\s+/)
        if (orig && new RegExp(`^(${FS_CALLS})$`).test(orig)) names.add((alias ?? orig).trim())
      }
  }
  // `import { promises as fsp } from 'node:fs'` and `fs.promises.readFile`
  for (const m of text.matchAll(/\{[^}]*\bpromises\s+as\s+(\w+)[^}]*\}\s*from\s+['"](?:node:)?fs['"]/g)) spaces.add(m[1])
  return { names, spaces }
}

/** The end offset (exclusive) of the call whose `(` is at `open`, or -1. */
function closeOf(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

export function findViolations(text) {
  const code = codeOnly(text)
  const { names, spaces } = fsPromiseNames(text)
  const direct = names.size ? new RegExp(`(?<![.\\w])(${[...names].join('|')})\\s*\\(`) : null
  const viaSpace = spaces.size
    ? new RegExp(`\\b(${[...spaces].join('|')})\\s*\\.\\s*(${FS_CALLS})\\s*\\(`)
    : null
  const promisesDot = new RegExp(`\\bpromises\\s*\\.\\s*(${FS_CALLS})\\s*\\(`)
  const lines = text.split('\n')
  const lineAt = (offset) => code.slice(0, offset).split('\n').length
  const out = []
  for (const m of code.matchAll(/\bPromise\s*\.\s*(all|allSettled)\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const end = closeOf(code, open)
    if (end < 0) continue
    const span = code.slice(open, end)
    // Only a list mapped over: `Promise.all(xs.map(...))`, `Promise.all([...xs].map(...))`.
    if (!/\.\s*(map|flatMap)\s*\(/.test(span)) continue
    if (/\bfsSlot\s*\(/.test(span)) continue
    const fs =
      (direct && direct.exec(span)) || (viaSpace && viaSpace.exec(span)) || promisesDot.exec(span) || BUN_IO.exec(span)
    if (!fs) continue
    const line = lineAt(m.index)
    const before = lines[line - 2] ?? ''
    if (/\/\/\s*fanout-ok\b/.test(lines[line - 1] ?? '') || /\/\/\s*fanout-ok\b/.test(before)) continue
    out.push({
      line,
      message: `Promise.${m[1]} maps a list onto async fs calls (${fs[0].replace(/\s*\($/, '')}): each item in flight starts a Bun I/O thread that is never given back. Read one at a time, or wrap each fs call in fsSlot (server/src/core/fs-slots.ts).`,
    })
  }
  return out
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, files)
    else if (SOURCE.test(name) && !SKIP_FILE.test(name)) files.push(p)
  }
  return files
}

export const audit = {
  id: ID,
  title: 'Never fan a data-sized list out onto async fs calls in a Bun process',
  gating: true,
  async run({ root }) {
    const findings = []
    let scanned = 0
    for (const r of ROOTS) {
      const dir = join(root, r)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      for (const file of walk(dir)) {
        scanned++
        const rel = relative(root, file).split(sep).join('/')
        for (const v of findViolations(readFileSync(file, 'utf8'))) findings.push({ ...v, file: rel })
      }
    }
    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} unbounded fs fan-out(s):\n${findings
          .map((f) => `- ${f.file}:${f.line} ${f.message}`)
          .join('\n')}`
      : `No list is fanned out onto async fs calls, in ${scanned} file(s). ✓`
    return { failed, findings, report }
  },
}

// Standalone CLI: prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}

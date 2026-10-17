// Guardrail against copying and reversing an array only to search it from the end.
//
// THE FAILURE (2026-10-16): the efficiency audit's c8adea42 replaced
// `[...w.attempts].reverse().find((a) => a.account.id === w.accountId)` with `findLast` in
// climayte-lib.ts. The identical line sat on in climayte-queue-sync.ts (once per worker on every
// queue snapshot), climayte-launch.ts and climayte-steer.ts, and the same shape in six more places,
// among them the Desk orchestrator's waitingQuestion, which copied a chat's whole transcript for each
// chat on every plan read. A fix made in one file did not reach its siblings; this check does.
//
// THE RULE: never build a reversed copy just to search it. `findLast` / `findLastIndex` search from
// the end in place, and `some` / `every` / `includes` give the same answer in either order:
//   [...xs].reverse().find(p)      ->  xs.findLast(p)
//   xs.slice().reverse().findIndex ->  xs.findLastIndex(p)   (an index from the END: n - 1 - i)
//   xs.toReversed().some(p)        ->  xs.some(p)
//
// DELIBERATELY NOT FLAGGED: a reversed copy that is kept, rendered or iterated
// (`computed(() => [...days].reverse())`, `for (const r of [...xs].reverse())`). Those need the
// order, and a list drawn on screen is bounded by the screen.
//
// Self-contained by design, like its siblings here: node stdlib only, plain finding objects.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'reversed-copy-to-search'
const ROOTS = [
  'server/src',
  'desk2/server/src',
  'desk2/web/src',
  'desk2/hydra/src',
  'core/src',
  'hydra-core',
  'orchestrator/server/src',
  'orchestrator/web/src',
]
const SOURCE = /\.(ts|tsx|mts|mjs|js|vue)$/
const SKIP_DIR = new Set(['node_modules', 'dist', 'tests', 'test', '__tests__', 'fixtures'])
const SKIP_FILE = /\.(test|spec)\.[a-z]+$|\.d\.ts$/
// A reversed COPY ([...x].reverse(), x.slice().reverse(), x.toReversed()) searched at once.
const SHAPE =
  /(\[\s*\.\.\.[^\]]+\]\s*\.\s*reverse\s*\(\s*\)|\.\s*slice\s*\(\s*\)\s*\.\s*reverse\s*\(\s*\)|\.\s*toReversed\s*\(\s*\))\s*\.\s*(find|findIndex|some|every|includes|indexOf)\s*\(/

/** The code part of one line: a line comment and the inside of string literals do not count. */
function codeOf(line) {
  let out = ''
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    out += ch
  }
  return out
}

export function findViolations(text) {
  const out = []
  let inBlock = false
  for (const [i, raw] of text.split('\n').entries()) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    const start = line.indexOf('/*')
    if (start >= 0 && line.indexOf('*/', start + 2) < 0) {
      inBlock = true
      line = line.slice(0, start)
    }
    const code = codeOf(line.replace(/\/\*.*?\*\//g, ''))
    const m = SHAPE.exec(code)
    if (!m) continue
    const method = m[2]
    const use =
      method === 'find'
        ? 'findLast'
        : method === 'findIndex'
          ? 'findLastIndex (an index from the end)'
          : method === 'indexOf'
            ? 'lastIndexOf (an index from the end)'
            : `${method} on the original (order does not change its answer)`
    out.push({
      line: i + 1,
      message: `a reversed copy is built only to ${method}() it: use ${use}, which reads the array in place.`,
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
  title: 'Never copy and reverse an array only to search it from the end',
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
      ? `Found ${findings.length} reversed copy(ies) built only to search:\n${findings
          .map((f) => `- ${f.file}:${f.line} ${f.message}`)
          .join('\n')}`
      : `No reversed copy is built only to search it, in ${scanned} file(s). ✓`
    return { failed, findings, report }
  },
}

// Standalone CLI: prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}

// Guardrail: the stdio MCP server must never reach the SQLite database module through a static import.
//
// THE RULE: starting at server/src/mcp.ts, follow every relative `import ... from` and
// `export ... from` (and bare `import './x'`) transitively. The walk must never arrive at
// server/src/db.ts. `import type` does not count, since it is erased at compile time. A dynamic
// `await import()` is not followed, because mcp.ts loads some modules lazily on purpose.
//
// WHY. The MCP server runs as its own process and deliberately does not race the daemon for its
// SQLite file (see the note in mcp.ts around line 512). db.ts opens that file on
// import, so a single stray static import gives every MCP client a second connection to the daemon's
// database. That is how it happened once: a claude-cloud adapter imported the poller, the poller
// reached db.ts, and the MCP server's tree picked it up. The static check is the regression net.
//
// LIMITS. Comments are blanked with a small scanner that honours string literals, so a `'/*'` in a
// string does not hide code. A regex literal containing `/*` or a quote can still confuse it, as the
// sibling checks' scanners can. Nothing here follows package imports, only relative paths.
// KNOWN GAP, the runtime path this check does not see: mcp.ts loads './usage-service' lazily with
// `await import()` (the offline usage path in localUsageForInstance), and usage-service.ts imports
// db.ts, so the MCP process does open the database on that path. The static guard does not cover it.
//
// Self-contained by design, like its siblings here: node stdlib only, plain finding objects.

import { readFileSync, statSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'mcp-server-opens-no-database'
const ENTRY = 'server/src/mcp.ts'
const TARGET = 'server/src/db.ts'
// Tried in this order, as the repo writes its relative imports: `./mcp-stdio.mjs` names the file
// itself, and `./core` names a folder's index.
const SUFFIXES = ['', '.ts', '.mjs', '.js', '/index.ts']

/** Blank comments and keep string literals whole, so a `'/*'` inside a string is not a comment.
 *  Newlines survive, so line numbers hold. */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const start = i
      i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
      out += src.slice(start, i + 1)
      i++
    } else if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      const stop = end < 0 ? src.length : end
      out += ' '.repeat(stop - i)
      i = stop
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

// A value import or re-export at the start of a line, with a relative specifier. `import type` is
// excluded by the lookahead. `import { type A, B }` still counts, because B is a value.
const VALUE_IMPORT = /^[ \t]*(?:import|export)\s+(?!type\b)(?:[^'"`;]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm
// The clause of an import or re-export before its specifier, when it is braced. Used to drop a clause
// whose every specifier is `type X`: TypeScript and Bun elide those, so they load nothing at runtime.
const BRACED_CLAUSE = /^[ \t]*(?:import|export)\s*\{([^}]*)\}\s*from\s*$/

/** True when a braced clause names specifiers and every one of them is `type X`. */
function onlyTypeSpecifiers(head) {
  const braced = BRACED_CLAUSE.exec(head)
  if (!braced) return false
  const specs = braced[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s))
}

/** The relative value imports of one file, with the line each sits on. */
function staticImports(text) {
  const code = stripComments(text)
  const out = []
  for (const m of code.matchAll(VALUE_IMPORT)) {
    // The text before the quoted specifier, which the match ends with.
    const head = m[0].replace(/['"][^'"]+['"]$/, '')
    if (onlyTypeSpecifiers(head)) continue
    out.push({ spec: m[1], line: code.slice(0, m.index).split('\n').length })
  }
  return out
}

/** The repo-relative file a relative specifier names, or null when none exists. */
function resolveSpec(from, spec, read) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  for (const suffix of SUFFIXES) {
    if (read(base + suffix) !== null) return base + suffix
  }
  return null
}

/**
 * The shortest import chain from the entry to the target, as the files in order and the line each
 * one's import sits on. Null when the target is not reachable.
 */
function findChain(read) {
  const seen = new Map([[ENTRY, null]])
  const queue = [ENTRY]
  while (queue.length) {
    const file = queue.shift()
    if (file === TARGET) {
      const path = [TARGET]
      const lines = []
      let at = TARGET
      while (at !== ENTRY) {
        const edge = seen.get(at)
        path.unshift(edge.from)
        lines.unshift(edge.line)
        at = edge.from
      }
      return { path, lines }
    }
    const text = read(file)
    if (text === null) continue
    for (const { spec, line } of staticImports(text)) {
      const next = resolveSpec(file, spec, read)
      if (!next || seen.has(next)) continue
      seen.set(next, { from: file, line })
      queue.push(next)
    }
  }
  return null
}

/** The findings for one tree, read through `read(relPath)`, which returns the text or null. */
function violationsIn(read) {
  if (read(ENTRY) === null) {
    return [
      {
        id: ID,
        file: ENTRY,
        line: 1,
        severity: 'error',
        message: `${ENTRY} not found, so this guardrail checked nothing.`,
        fix: 'Point ENTRY at the stdio MCP server module, or delete this check if that server is gone.',
      },
    ]
  }
  if (read(TARGET) === null) {
    return [
      {
        id: ID,
        file: ENTRY,
        line: 1,
        severity: 'error',
        message: `${TARGET} not found, so no import can reach the database module and the check passed for nothing.`,
        fix: 'Point TARGET at the SQLite database module, or delete this check if that module is gone.',
      },
    ]
  }
  const chain = findChain(read)
  if (!chain) return []
  const shown = chain.path
    .map((file, i) => (i < chain.lines.length ? `${file}:${chain.lines[i]}` : file))
    .join(' -> ')
  return [
    {
      id: ID,
      file: ENTRY,
      line: chain.lines[0] ?? 1,
      severity: 'error',
      message:
        `${ENTRY} reaches the SQLite database module through static imports: ${shown}. ` +
        'db.ts opens SQLite on import, and the MCP server must not race the daemon for that file.',
      fix:
        'Cut the chain: move what the MCP server needs into a module with no import of db.ts, or ' +
        'load the module that needs it with await import() where mcp.ts uses it, as mcp.ts already does.',
    },
  ]
}

/**
 * The check's entry point for a tree held in memory. Unlike the sibling checks, which take one text,
 * this takes a map of repo-relative path to text, because the rule is about a chain of files. The
 * generic harness in tests/guardrails.test.ts calls findViolations(text) for registered fixtures, so
 * a string here throws rather than reading as an empty tree that says "not found".
 */
export function findViolations(files) {
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new TypeError(
      'mcp-server-opens-no-database findViolations takes a map of repo-relative path to text, ' +
        "e.g. { 'server/src/mcp.ts': '...' }, not a single string",
    )
  }
  return violationsIn((rel) => (Object.hasOwn(files, rel) ? files[rel] : null))
}

function readRepoFile(root, rel) {
  const path = join(root, rel)
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

export const audit = {
  id: ID,
  title: 'The stdio MCP server must not reach the database module by a static import',
  gating: true,
  async run({ root }) {
    const findings = violationsIn((rel) => readRepoFile(root, rel))
    const failed = findings.length > 0
    const report = failed
      ? findings.map((f) => `- ${f.message}`).join('\n')
      : `${ENTRY} reaches no database module through static imports. ✓`
    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}

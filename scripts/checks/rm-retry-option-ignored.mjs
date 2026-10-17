// Guardrail: an rmSync that passes maxRetries or retryDelay retries nothing under Bun.
//
// Node's rmSync retries EBUSY, EPERM and ENOTEMPTY when given maxRetries, waiting retryDelay longer each time. Bun's
// does not: on 2026-10-17 Bun 1.4.3 threw EBUSY after 0 ms with `maxRetries: 10` on a folder a child process had
// 700 ms left in. Windows holds a folder for a moment after the processes in it are gone, so this repo's tests passed
// those options in 34 cleanups to ride that moment out, and every one of them was a single try.
// server/tests/climayte-runner-job.test.ts had added `maxRetries: 10` for exactly this on 2026-10-15; it failed
// windows-latest on the same EBUSY two days later (run 39025476619).
//
// The rule: no rmSync call carries maxRetries or retryDelay. A test removes its folders with rmRetry
// (server/tests/rm-retry.ts, desk2/server/test/rm-retry.ts), which tries again for real.
//
// DELIBERATELY NOT FLAGGED: the async rm and fs.promises.rm (not measured under Bun; nothing here passes them retry
// options), and the words inside a comment or string literal, both blanked before the scan, so a comment explaining
// this rule is not a finding.
//
// Self-contained by design (same reason as the other checks here): imports nothing but node stdlib,
// and returns plain finding objects for the runner.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'rmsync-retry-option-ignored'
const EXTS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
const RM_SYNC = /(?<![\w$])rmSync\s*\(/g
const RETRY_OPTION = /\b(?:maxRetries|retryDelay)\b/

/** Index just past the regex literal opening at `start`, or -1 if it does not close on that line.
 *  `/` inside a `[...]` class is literal, so classes are tracked. */
function endOfRegex(text, start) {
  let inClass = false
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === '\n') return -1
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '/') return j + 1
  }
  return -1
}

// A `/` opens a regex only where an expression is expected. A missed regex can carry a bare quote,
// which opens a string that never closes and inverts code/string for the rest of the file.
const REGEX_OPENS_AFTER = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>'],
)
const REGEX_OPENS_AFTER_KEYWORD =
  /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/

/** One scanner step inside a string/template literal opened by `quote`: blanks the current char (or
 *  escape pair) in `out` in place. */
function advanceInString(text, out, i, quote, prev) {
  const ch = text[i]
  if (ch === '\\') {
    if (text[i] !== '\n') out[i] = ' '
    if (text[i + 1] !== '\n') out[i + 1] = ' '
    return { i: i + 2, inString: quote, prev }
  }
  if (ch === quote) {
    return { i: i + 1, inString: null, prev: ch }
  }
  if (ch !== '\n') out[i] = ' '
  return { i: i + 1, inString: quote, prev }
}

/** One scanner step outside a string: opens a string, blanks a comment or a regex literal, or
 *  advances one character while tracking `prev`, the last non-whitespace char. */
function advanceCode(text, out, i, prev) {
  const ch = text[i]
  if (ch === '"' || ch === "'" || ch === '`') {
    return { i: i + 1, inString: ch, prev }
  }
  if (ch === '/' && text[i + 1] === '/') {
    let j = i
    while (j < text.length && text[j] !== '\n') out[j++] = ' '
    return { i: j, inString: null, prev }
  }
  if (ch === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2)
    const stop = end === -1 ? text.length : end + 2
    for (let j = i; j < stop; j++) if (text[j] !== '\n') out[j] = ' '
    return { i: stop, inString: null, prev }
  }
  if (
    ch === '/' &&
    (prev === '' ||
      REGEX_OPENS_AFTER.has(prev) ||
      REGEX_OPENS_AFTER_KEYWORD.test(text.slice(0, i).trimEnd()))
  ) {
    const end = endOfRegex(text, i)
    if (end !== -1) {
      for (let j = i; j < end; j++) if (text[j] !== '\n') out[j] = ' '
      return { i: end, inString: null, prev: '/' }
    }
  }
  const nextPrev = /\s/.test(ch) ? prev : ch
  return { i: i + 1, inString: null, prev: nextPrev }
}

/** Blank comments and the INTERIOR of every string/template literal with spaces, so every surviving
 *  character keeps its original index (line numbers and the specifier lookup both rely on that).
 *  Quotes and braces are preserved so spans and depth still balance. */
function blankNonCode(text) {
  const out = text.split('')
  let inString = null
  let prev = ''
  let i = 0
  while (i < text.length) {
    const step = inString ? advanceInString(text, out, i, inString, prev) : advanceCode(text, out, i, prev)
    i = step.i
    inString = step.inString
    prev = step.prev
  }
  return out.join('')
}

/** Extract `text` from `open` (a bracket) through its match. Operates on blanked code. */
function extractBalanced(text, open, oc = '(', cc = ')') {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === oc) depth++
    else if (c === cc) {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

/** Every rmSync call whose argument list names maxRetries or retryDelay, one finding per call. */
export function findViolations(text) {
  const code = blankNonCode(text)
  const out = []
  for (const m of code.matchAll(RM_SYNC)) {
    const open = m.index + m[0].length - 1
    if (!RETRY_OPTION.test(extractBalanced(code, open))) continue
    out.push({
      id: ID,
      line: code.slice(0, m.index).split('\n').length,
      severity: 'error',
      message:
        'rmSync with maxRetries/retryDelay: Bun ignores both, so this is one try. Windows holds a folder for a ' +
        'moment after the processes in it are gone, and the EBUSY then fails the test (climayte-runner-job, 2026-10-17).',
      fix: 'Call rmRetry(path) from server/tests/rm-retry.ts (desk2: desk2/server/test/rm-retry.ts), which really retries.',
    })
  }
  return out
}

function trackedSources(root) {
  const listing = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return listing.split('\0').filter((rel) => EXTS.test(rel))
}

export const audit = {
  id: ID,
  title: 'rmSync must not pass maxRetries or retryDelay (Bun ignores them; use rmRetry)',
  gating: true,
  async run({ root = process.cwd() } = {}) {
    const findings = []
    let files = []
    try {
      files = trackedSources(root)
    } catch (err) {
      findings.push({
        id: ID,
        file: '.',
        line: 1,
        message: `git ls-files failed under ${root} (${String(err.message).split('\n')[0]}); this check read nothing.`,
      })
    }
    let read = 0
    for (const rel of files) {
      let text
      try {
        text = readFileSync(join(root, rel), 'utf8')
      } catch (err) {
        // Tracked but deleted in the working tree, or a submodule's directory: nothing to read.
        if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') continue
        throw err
      }
      read++
      if (!text.includes('rmSync')) continue
      for (const v of findViolations(text)) {
        findings.push({ ...v, file: rel, message: `${rel}:${v.line} ${v.message}` })
      }
    }
    if (read === 0 && findings.length === 0) {
      findings.push({
        id: ID,
        file: '.',
        line: 1,
        message: `no tracked source file under ${root}; fix this check's EXTS or root rather than trusting its pass.`,
      })
    }
    const failed = findings.length > 0
    const report = failed
      ? `rmSync retry options: ${findings.length} problem(s):\n` +
        findings.map((f) => `- ${f.message}${f.fix ? `\n  fix: ${f.fix}` : ''}`).join('\n')
      : `${read} tracked source file(s): no rmSync passes maxRetries or retryDelay.`
    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}

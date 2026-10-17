// Guardrail: no raw control bytes in tracked source files.
//
// desk2/server/src/engine/pushback.ts held four raw backspace bytes (0x08) where its 'asks
// permission' regex meant the word boundary `\b`, from d5e3904b until 2026-10-16. A backspace in a
// regex matches only a backspace, so the pattern could never match and every turn that asked the
// owner's permission was counted as clean. Nothing failed and nothing looked wrong: an editor draws
// the byte as nothing at all. The likely cause is a file written through a shell, which halves
// backslashes, so `\\b` went in as `\b` and a heredoc or printf turned that into the byte itself.
// The same scan found server/src/incidents.ts carrying two raw 0x01 separators inside a template
// literal; those were harmless, and are now the escape `\x01`, which builds the identical string.
//
// The rule: a checked file holds no byte in 0x00-0x08, 0x0B, 0x0C or 0x0E-0x1F. TAB, LF and CR are
// the only control bytes source needs. ESC (0x1B) is rejected too: no tracked file needed it on
// 2026-10-16, and an ANSI colour code reads better as `\x1b[` anyway. Bytes of 0x80 and up never
// form a control byte in UTF-8, so the scan is the same on the decoded text as on the raw bytes.
//
// WHICH FILES: every file `git ls-files` lists under the root with one of EXTS. Tracked only, so
// node_modules, build output and scratch files are never read; a file git lists but the working
// tree has deleted is skipped. A root git cannot list, or a listing with no source file in it, is
// a finding: a check that read nothing must not report a pass.
//
// Self-contained by design (same reason as the other checks here): imports nothing but node stdlib,
// and returns plain finding objects for the runner.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'raw-control-byte-in-source'
const EXTS = /\.(?:ts|tsx|mts|cts|vue|py|js|jsx|mjs|cjs)$/i
const BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g
const NAMES = { 0x00: 'NUL', 0x08: 'backspace', 0x0b: 'vertical tab', 0x0c: 'form feed', 0x1b: 'ESC' }

const describeByte = (code) => {
  const hex = `0x${code.toString(16).toUpperCase().padStart(2, '0')}`
  return NAMES[code] ? `${hex} ${NAMES[code]}` : hex
}

/** Every raw control byte in a source text, one finding per offending line. */
export function findViolations(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    const hits = [...line.matchAll(BAD)]
    if (hits.length === 0) return
    const kinds = [...new Set(hits.map((m) => m[0].charCodeAt(0)))].map(describeByte).join(', ')
    out.push({
      id: ID,
      line: i + 1,
      column: hits[0].index + 1,
      severity: 'error',
      message:
        `column ${hits[0].index + 1}: ${hits.length} raw control byte(s) (${kinds}). An editor ` +
        'draws them as nothing, and in a regex or string they mean themselves, not the escape that ' +
        'was probably meant: pushback.ts had backspace bytes where `\\b` was meant, so its pattern never matched.',
      fix:
        'Write the escape instead: `\\b` where a regex word boundary was meant, otherwise `\\xNN` ' +
        '(`\\x01`, `\\x08`), which builds the identical string. Write the file with an editor tool, not ' +
        'a shell heredoc: the shell halves backslashes.',
    })
  })
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
  title: 'Tracked source files must not hold raw control bytes (write the escape, e.g. \\b or \\x01)',
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
      ? `Raw control bytes: ${findings.length} problem(s):\n` +
        findings.map((f) => `- ${f.message}${f.fix ? `\n  fix: ${f.fix}` : ''}`).join('\n')
      : `${read} tracked source file(s): no raw control bytes.`
    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}

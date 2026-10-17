#!/usr/bin/env node
/**
 * People guard. The repo is PUBLIC; people (personas, portraits, rosters, the owner's identifiers) live on
 * the user's PC (~/.agenthydra/people/) or in their Connections account, never here. See docs/PEOPLE.md.
 *
 * Used three ways: `node .githooks/check-people.mjs` (staged files, from pre-commit), with `--all` (every
 * tracked file), and imported by server/tests/people-guard.test.ts.
 *
 * Owner identifiers are never written here. They are SHA-256 digests of normalised tokens in
 * ~/.agenthydra/people-guard.local.json ({ "tokenSha256": [...] }); an absent file skips that rule.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const FIXTURES_DIR = 'server/tests/fixtures/people-examples/'
/** Older invented-example folders (manager loader tests: alpha-ui, beta-backend ...). */
const ALLOWED = [FIXTURES_DIR]
/** Already-committed owner traces, left in place and listed in the report for the owner to decide on. */
const KNOWN_EXISTING = new Set(['.gitignore'])
export const LOCAL_FILE = join(homedir(), '.agenthydra', 'people-guard.local.json')

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i
const BINARY = /\.(zip|gz|exe|dll|woff2?|ico|pdf|node|wasm)$/i
const PORTRAIT_PATH = /(^|[/_.-])(portraits?|avatars?|headshots?|profile[-_]?pics?)([/_.-]|$)/i
const ROSTER_NAME = /roster/i
const TEXT_LIMIT = 1_000_000

/** Lower-case word-ish tokens; dotted hosts and emails also yield their parts and dot-suffixes. */
export function tokensOf(text) {
  const out = new Set()
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9@._-]*[a-z0-9]/g) ?? []) {
    out.add(raw)
    for (const part of raw.split('@')) out.add(part)
    const labels = raw.split('@').pop().split('.')
    for (let i = 1; i < labels.length - 1; i++) out.add(labels.slice(i).join('.'))
    for (const w of raw.split(/[._-]/)) if (w.length >= 4) out.add(w)
  }
  return out
}
export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex')

export function loadOwnerHashes(file = LOCAL_FILE) {
  if (!existsSync(file)) return new Set()
  try {
    return new Set(JSON.parse(readFileSync(file, 'utf8')).tokenSha256 ?? [])
  } catch {
    return new Set()
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const looksLikePersona = (o) =>
  isObj(o) &&
  typeof o.name === 'string' &&
  typeof o.oneLiner === 'string' &&
  (Array.isArray(o.keywords) || Array.isArray(o.modes))

/** Returns a reason string for people content in this one file, or null. */
export function inspect(path, read, ownerHashes) {
  const fixture = ALLOWED.some((d) => path.startsWith(d))
  const base = basename(path)
  if (!fixture) {
    if (IMAGE.test(path) && PORTRAIT_PATH.test(path)) return 'portrait image'
    if (/^(persona|brief)\.(json|md)$/i.test(base) && /(^|\/)people\//i.test(path)) return 'file inside a people folder'
    if (base.toLowerCase() === 'persona.json') return 'persona.json outside the fixtures folder'
    if (ROSTER_NAME.test(base) && /\.(json|csv|jsonl|tsv)$/i.test(base)) return 'roster dump'
  }
  if (IMAGE.test(path) || BINARY.test(path)) return null
  const buf = read(path)
  if (!buf || buf.length > TEXT_LIMIT) return null
  const text = buf.toString('utf8')
  if (!fixture && base.toLowerCase().endsWith('.json')) {
    try {
      const j = JSON.parse(text)
      if (looksLikePersona(j)) return 'persona format (docs/PEOPLE.md)'
      if (Array.isArray(j) && j.filter(looksLikePersona).length >= 3) return 'roster dump (3+ personas)'
    } catch {}
  }
  if (ownerHashes.size && !KNOWN_EXISTING.has(path)) {
    for (const t of tokensOf(text)) {
      if (ownerHashes.has(sha256Hex(t))) return 'owner identifier (matches people-guard.local.json)'
    }
  }
  return null
}

export function scan(paths, read = (p) => (statSync(p, { throwIfNoEntry: false })?.isFile() ? readFileSync(p) : null)) {
  const owner = loadOwnerHashes()
  const hits = []
  for (const p of paths) {
    const why = inspect(p, read, owner)
    if (why) hits.push({ file: p, why })
  }
  return hits
}

export const REFUSAL = `
People content must not be committed: this repo is public.
People (personas, portraits, rosters, your own name/email/paths) belong on your PC under
~/.agenthydra/people/<family>/<slug>/, or in your Connections account. Invented examples for tests go in
${FIXTURES_DIR}. See docs/PEOPLE.md. (Bypass only if you are sure: git commit --no-verify)`

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean)

if (process.argv[1]?.endsWith('check-people.mjs')) {
  const files = process.argv.includes('--all') ? git('ls-files') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
  const hits = scan(files)
  if (hits.length) {
    for (const h of hits) console.error(`  x ${h.file}: ${h.why}`)
    console.error(REFUSAL)
    process.exit(1)
  }
}

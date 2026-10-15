import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function homeDir() {
  return process.env.PRICECHECK_HOME || path.join(os.homedir(), '.agenthydra', 'pricecheck')
}

export const adviceFile = () => path.join(homeDir(), 'advice.jsonl')
export const callsFile = () => path.join(homeDir(), 'calls.jsonl')

export function appendRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
}

export function readRows(file) {
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return rows
}

export const newId = () => randomBytes(4).toString('hex')

let cachedVersion

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.mjs') ? [full] : []
  })
}

export function pricecheckVersion() {
  if (cachedVersion) return cachedVersion
  const hash = createHash('sha256')
  for (const file of sourceFiles(LIB).sort()) {
    hash.update(path.relative(LIB, file).split(path.sep).join('/'))
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  cachedVersion = hash.digest('hex').slice(0, 12)
  return cachedVersion
}

export function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function adviceRow(item, head) {
  return {
    type: 'advice',
    id: item.id ?? newId(),
    at: new Date().toISOString(),
    kind: item.kind,
    root: item.root,
    repo: item.root ? path.basename(item.root) : undefined,
    page: item.page,
    points: item.points,
    files: item.files,
    claim: item.claim,
    version: pricecheckVersion(),
    head,
  }
}

export function recordAdvices(items) {
  const heads = new Map()
  const ids = []
  for (const item of items) {
    if (item.points === 0) continue
    const id = item.id ?? newId()
    try {
      if (!heads.has(item.root)) heads.set(item.root, item.root ? gitHead(item.root) : null)
      appendRow(adviceFile(), adviceRow({ ...item, id }, heads.get(item.root)))
    } catch {
      // advice is advisory: a failed write must not break the command that gave it
    }
    ids.push(id)
  }
  return ids
}

export function recordAdvice(item) {
  return recordAdvices([item])[0] ?? null
}

function rootOf(args) {
  const at = args.indexOf('--root')
  return at >= 0 && args[at + 1] ? path.resolve(args[at + 1]) : path.resolve(process.cwd())
}

export function recordCall({ cmd, args = [], ms, exit }) {
  try {
    appendRow(callsFile(), {
      at: new Date().toISOString(),
      cmd,
      args,
      root: rootOf(args),
      ms,
      exit,
      version: pricecheckVersion(),
    })
  } catch {
    return
  }
}

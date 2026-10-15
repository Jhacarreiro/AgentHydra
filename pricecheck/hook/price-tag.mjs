#!/usr/bin/env node
// PostToolUse hook: after an edit to a UI file or a locale catalog, tells the model what the edit costs the page.
// It never blocks an edit: any failure prints nothing and exits 0.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const UI_EXT = new Set(['.vue', '.tsx', '.jsx', '.svelte', '.html', '.astro'])
const CATALOG_EXT = new Set(['.json', '.ts', '.js'])
const CATALOG_DIRS = new Set(['locales', 'locale', 'i18n', 'lang', 'messages'])
const GIT_TIMEOUT_MS = 1000
const CLI_TIMEOUT_MS = 6000
const MAX_PAGES = 3
const HERE = path.dirname(fileURLToPath(import.meta.url))

function switchedOff(env) {
  if (env.PRICECHECK_HOOK === 'off') return true
  const home = env.PRICECHECK_HOME || path.join(os.homedir(), '.agenthydra', 'pricecheck')
  return existsSync(path.join(home, 'hook-off'))
}

function isPriced(file) {
  const ext = path.extname(file).toLowerCase()
  if (UI_EXT.has(ext)) return true
  if (!CATALOG_EXT.has(ext)) return false
  return file.split(/[\\/]/).slice(0, -1).some((dir) => CATALOG_DIRS.has(dir.toLowerCase()))
}

function repoRoot(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function measure(root, file) {
  const cli = process.env.PRICECHECK_CLI || path.resolve(HERE, '..', 'bin', 'pricecheck.mjs')
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn(
      process.execPath,
      [cli, 'diff', '--against', 'HEAD', '--files', file, '--json', '--root', root],
      { cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish(null)
    }, CLI_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? parse(out) : null))
  })
}

function parse(text) {
  try {
    const data = JSON.parse(text)
    return Array.isArray(data?.changed) ? data : null
  } catch {
    return null
  }
}

const signed = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n)}`
const plural = (unit, n) => (Math.abs(n) === 1 || unit === 'media' ? unit : `${unit}s`)

function unitsText(units = {}) {
  return Object.entries(units)
    .filter(([, n]) => Number.isFinite(n) && n !== 0)
    .map(([unit, n]) => `${signed(n)} ${plural(unit, n)}`)
    .join(', ')
}

function describeLine(page) {
  const top = [...(page.files ?? [])]
    .filter((f) => typeof f?.file === 'string')
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))[0]
  const words = top ? unitsText(top.units) : ''
  const where = top ? ` in ${top.file}` : ''
  const detail = words ? `${signed(page.delta)}: ${words}${where}` : `${signed(page.delta)}${where}`
  const verdict = page.delta < 0 ? ', cheaper' : ''
  return `Price check: this edit makes ${page.page} ${page.before} -> ${page.after} points${verdict} (${detail}).`
}

export function render(report) {
  const pages = (report.changed ?? []).filter((p) => p && typeof p.page === 'string' && Number.isFinite(p.delta) && p.delta !== 0)
  if (!pages.length) return null
  const shown = pages.length > MAX_PAGES ? pages.slice(0, MAX_PAGES - 1) : pages
  const lines = shown.map(describeLine)
  if (pages.length > MAX_PAGES) lines.push(`+${pages.length - shown.length} more pages`)
  lines.push(`Every point is attention the person pays; cheaper wins. pricecheck page ${pages[0].page} shows the whole bill.`)
  return lines.join('\n')
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

async function main() {
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch {
    return
  }
  if (!TOOLS.has(input?.tool_name) || switchedOff(process.env)) return
  const target = input.tool_input?.file_path
  if (typeof target !== 'string' || !isPriced(target)) return
  const abs = path.resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd(), target)
  const root = repoRoot(path.dirname(abs))
  if (!root) return
  const rel = path.relative(root, abs)
  if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return
  const report = await measure(root, rel.split(path.sep).join('/'))
  const text = report && render(report)
  if (!text) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }))
}

main().catch(() => {})

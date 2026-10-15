// `pricecheck install`: registers the MCP server with a stub `claude` on PATH and installs the price-tag hook into a
// temp settings file. The real ~/.claude is never touched.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, describe as group, test } from 'bun:test'

const ROOT = join(import.meta.dirname, '..', '..')
const BIN = join(ROOT, 'bin', 'pricecheck.mjs')
const REGISTERED_LINE = `claude mcp add --scope user pricecheck -- node "${BIN}" mcp`

const STUB = `import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
const dir = process.env.STUB_DIR
const args = process.argv.slice(2)
appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\\n')
const regFile = dir + '/registered.json'
const reg = existsSync(regFile) ? JSON.parse(readFileSync(regFile, 'utf8')) : null
if (args[0] === 'mcp' && args[1] === 'get') {
  if (!reg) { process.stderr.write('No MCP server found with name: pricecheck\\n'); process.exit(1) }
  process.stdout.write('pricecheck:\\n  Command: node\\n  Args: ' + reg.join(' ') + '\\n')
  process.exit(0)
}
if (args[0] === 'mcp' && args[1] === 'add') {
  const dashes = args.indexOf('--')
  writeFileSync(regFile, JSON.stringify(args.slice(dashes + 1)))
  process.exit(0)
}
process.exit(0)
`

let dir
let home
let settings
let pathDir
let emptyDir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pricecheck-install-'))
  home = join(dir, 'home')
  mkdirSync(home)
  settings = join(dir, 'settings.json')
  pathDir = join(dir, 'bin')
  mkdirSync(pathDir)
  emptyDir = join(dir, 'empty')
  mkdirSync(emptyDir)
  writeFileSync(join(dir, 'stub.mjs'), STUB)
  writeFileSync(join(pathDir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'stub.mjs')}" "$@"\n`)
  chmodSync(join(pathDir, 'claude'), 0o755)
  writeFileSync(join(pathDir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${join(dir, 'stub.mjs')}" %*\r\n`)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = (args, { withClaude = true } = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PATH: withClaude ? pathDir : emptyDir,
      HOME: home,
      USERPROFILE: home,
      STUB_DIR: dir,
      AGENTHYDRA_CLAUDE_SETTINGS: settings,
      PRICECHECK_HOME: join(dir, 'pc'),
    },
  })

const calls = () => {
  const file = join(dir, 'calls.log')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

group('pricecheck install', () => {
  test('registers the MCP server once with claude, then is a no-op', () => {
    const first = run(['install'])
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('pricecheck')
    const adds = calls().filter((c) => c[0] === 'mcp' && c[1] === 'add')
    expect(adds.length).toBe(1)
    expect(adds[0]).toEqual(['mcp', 'add', '--scope', 'user', 'pricecheck', '--', 'node', BIN, 'mcp'])

    const second = run(['install'])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already registered')
    expect(calls().filter((c) => c[0] === 'mcp' && c[1] === 'add').length).toBe(1)
  })

  test('installs the price-tag hook into the settings file it is given', () => {
    run(['install'])
    const doc = JSON.parse(readFileSync(settings, 'utf8'))
    const entries = doc.hooks.PostToolUse.flatMap((g) => g.hooks)
    expect(entries.some((h) => String(h.command).includes('price-tag'))).toBe(true)
  })

  test('without claude on PATH it prints the exact registration line and registers nothing', () => {
    const res = run(['install'], { withClaude: false })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain(REGISTERED_LINE)
    expect(calls().length).toBe(0)
  })

  test('--dry-run prints the registration and changes nothing', () => {
    const res = run(['install', '--dry-run'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain(REGISTERED_LINE)
    expect(calls().filter((c) => c[0] === 'mcp' && c[1] === 'add').length).toBe(0)
    expect(existsSync(settings)).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { install, status, uninstall } from '../../hook/install.mjs'

const HOOK_PATH = path.join(os.tmpdir(), 'Agent Hydra', 'pricecheck', 'hook', 'price-tag.mjs')
const OTHER = { type: 'command', command: 'node "C:/tools/other-hook.mjs"', timeout: 5 }

let dir
let settings

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pricecheck-install-'))
  settings = path.join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = () => JSON.parse(readFileSync(settings, 'utf8'))
const backups = () => readdirSync(dir).filter((name) => name.includes('.bak-'))

function seed(data) {
  writeFileSync(settings, `${JSON.stringify(data, null, 2)}\n`)
  return readFileSync(settings, 'utf8')
}

describe('price tag installer', () => {
  test('creates the settings file with one PostToolUse group and no backup', () => {
    const r = install({ settingsPath: settings, hookPath: HOOK_PATH })
    expect(r.changed).toBe(true)
    expect(r.backup).toBeNull()
    expect(read().hooks.PostToolUse).toEqual([
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [{ type: 'command', command: `node "${HOOK_PATH}"`, timeout: 8 }],
      },
    ])
    expect(status({ settingsPath: settings }).installed).toBe(true)
  })

  test('a second install changes nothing and makes no backup', () => {
    install({ settingsPath: settings, hookPath: HOOK_PATH })
    const before = readFileSync(settings, 'utf8')
    const r = install({ settingsPath: settings, hookPath: HOOK_PATH })
    expect(r.changed).toBe(false)
    expect(readFileSync(settings, 'utf8')).toBe(before)
    expect(backups()).toEqual([])
  })

  test('an existing file is backed up before the first change and other hooks stay as they were', () => {
    const original = seed({
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [OTHER] }],
        PostToolUse: [{ matcher: 'Edit', hooks: [OTHER] }],
      },
    })
    install({ settingsPath: settings, hookPath: HOOK_PATH })
    expect(backups()).toHaveLength(1)
    expect(readFileSync(path.join(dir, backups()[0]), 'utf8')).toBe(original)
    const data = read()
    expect(data.model).toBe('opus')
    expect(data.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [OTHER] }])
    expect(data.hooks.PostToolUse).toEqual([
      { matcher: 'Edit', hooks: [OTHER] },
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `node "${HOOK_PATH}"`, timeout: 8 }] },
    ])
  })

  test('a moved hook path is updated in place rather than added twice', () => {
    install({ settingsPath: settings, hookPath: HOOK_PATH })
    install({ settingsPath: settings, hookPath: '/elsewhere/pricecheck/hook/price-tag.mjs' })
    const groups = read().hooks.PostToolUse
    expect(groups).toHaveLength(1)
    expect(groups[0].hooks).toEqual([{ type: 'command', command: 'node "/elsewhere/pricecheck/hook/price-tag.mjs"', timeout: 8 }])
  })

  test('uninstall removes only its own entry and restores the file it found', () => {
    const original = seed({
      model: 'opus',
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [OTHER] }] },
    })
    install({ settingsPath: settings, hookPath: HOOK_PATH })
    const r = uninstall({ settingsPath: settings })
    expect(r.changed).toBe(true)
    expect(read()).toEqual(JSON.parse(original))
    expect(status({ settingsPath: settings }).installed).toBe(false)
  })

  test('uninstall on a file without the entry changes nothing', () => {
    const original = seed({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [OTHER] }] } })
    const r = uninstall({ settingsPath: settings })
    expect(r.changed).toBe(false)
    expect(readFileSync(settings, 'utf8')).toBe(original)
    expect(backups()).toEqual([])
  })

  test('uninstall with no settings file reports nothing to do and creates no file', () => {
    expect(uninstall({ settingsPath: settings }).changed).toBe(false)
    expect(existsSync(settings)).toBe(false)
  })

  test('uninstall after a single install leaves no empty hooks object behind', () => {
    seed({ model: 'opus' })
    install({ settingsPath: settings, hookPath: HOOK_PATH })
    uninstall({ settingsPath: settings })
    expect(read()).toEqual({ model: 'opus' })
  })
})

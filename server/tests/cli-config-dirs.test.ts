import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '../src/config'
import { isLoggedIn, listCliConfigDirs } from '../src/core/cli-instances'

// The root preload redirects CONFIG_DIR to scratch. Preserve any other fixture's registry.
const registry = join(CONFIG_DIR, 'cli-instances.json')
let previous: Buffer | null
let scratch: string
const spies: ReturnType<typeof spyOn>[] = []

beforeEach(() => {
  previous = existsSync(registry) ? readFileSync(registry) : null
  scratch = mkdtempSync(join(tmpdir(), 'ah-cli-config-dirs-'))
  mkdirSync(CONFIG_DIR, { recursive: true })
  rmSync(registry, { force: true })
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  if (previous === null) rmSync(registry, { force: true })
  else writeFileSync(registry, previous)
  rmSync(scratch, { recursive: true, force: true })
})

function store(instances: Array<{ id: string; configDir: string }>) {
  writeFileSync(registry, JSON.stringify({ instances }))
}

test('a missing registry lists no folders and is not created by the reader', () => {
  expect(listCliConfigDirs()).toEqual([])
  expect(existsSync(registry)).toBe(false)
})

test('corrupt registry bytes and invalid registry shapes are preserved', () => {
  store([])
  expect(listCliConfigDirs()).toEqual([])
  const error = spyOn(console, 'error').mockImplementation(() => {})
  spies.push(error)
  for (const raw of ['{invalid', '{"instances":{}}']) {
    writeFileSync(registry, raw)
    expect(listCliConfigDirs()).toEqual([])
    expect(listCliConfigDirs()).toEqual([])
    expect(readFileSync(registry, 'utf8')).toBe(raw)
  }
  expect(error).toHaveBeenCalledTimes(2)
})

test('new, removed and replaced records are visible on the next read', () => {
  const first = { id: 'first', configDir: join(scratch, 'first-custom') }
  const second = { id: 'second', configDir: join(scratch, 'second-custom') }
  store([first])
  const old = listCliConfigDirs()
  expect(old).toEqual([first.configDir])
  store([first, second])
  expect(listCliConfigDirs()).toEqual([first.configDir, second.configDir])
  store([second])
  expect(listCliConfigDirs()).toEqual([second.configDir])
  old.push('caller-only')
  expect(listCliConfigDirs()).toEqual([second.configDir])
  store([])
  expect(listCliConfigDirs()).toEqual([])
})

test('managed folders are canonical while custom folders, order and duplicates are preserved', () => {
  const custom = join(scratch, 'custom-config')
  store([
    { id: 'managed', configDir: join(scratch, 'legacy', 'managed') },
    { id: 'custom', configDir: custom },
    { id: 'duplicate', configDir: custom },
    { id: 'empty', configDir: '' },
  ])
  expect(listCliConfigDirs()).toEqual([
    join(CONFIG_DIR, 'cli-instances', 'managed'),
    custom,
    custom,
    '',
  ])
})

test('login removal and re-login do not freeze or filter the folder projection', () => {
  const configDir = join(scratch, 'custom-config')
  mkdirSync(configDir)
  const credentials = join(configDir, '.credentials.json')
  store([{ id: 'example', configDir }])
  expect(listCliConfigDirs()).toEqual([configDir])
  expect(isLoggedIn(configDir)).toBe(false)
  writeFileSync(credentials, '{}')
  expect(listCliConfigDirs()).toEqual([configDir])
  expect(isLoggedIn(configDir)).toBe(true)
  rmSync(credentials)
  expect(listCliConfigDirs()).toEqual([configDir])
  expect(isLoggedIn(configDir)).toBe(false)
  writeFileSync(credentials, '{}')
  expect(listCliConfigDirs()).toEqual([configDir])
  expect(isLoggedIn(configDir)).toBe(true)
})

test('the projection reads only the registry, never credential, identity or number metadata', () => {
  const configDir = join(scratch, 'custom-config')
  mkdirSync(configDir)
  writeFileSync(join(configDir, '.credentials.json'), '{"accessToken":"synthetic-test-token"}')
  writeFileSync(
    join(configDir, '.claude.json'),
    '{"oauthAccount":{"emailAddress":"owner@example.test"}}',
  )
  store([{ id: 'example', configDir }])
  const reads = spyOn(fs, 'readFileSync')
  const stats = spyOn(fs, 'statSync')
  const presence = spyOn(fs, 'existsSync')
  const parses = spyOn(JSON, 'parse')
  spies.push(reads, stats, presence, parses)
  expect(listCliConfigDirs()).toEqual([configDir])
  expect(reads).toHaveBeenCalledTimes(1)
  expect(reads.mock.calls[0]?.[0]).toBe(registry)
  expect(parses).toHaveBeenCalledTimes(1)
  expect(stats).not.toHaveBeenCalled()
  expect(presence).not.toHaveBeenCalled()
})

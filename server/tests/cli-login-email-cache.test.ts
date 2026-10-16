import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliLoginEmail } from '../src/core/cli-login-move'

const dirs: string[] = []
const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}, 30_000)

function fixture(email: unknown = 'first@example.test') {
  const configDir = mkdtempSync(join(tmpdir(), 'ah-cli-email-cache-'))
  dirs.push(configDir)
  const path = join(configDir, '.claude.json')
  const text = (email: unknown) =>
    JSON.stringify({ oauthAccount: { emailAddress: email }, unrelated: 'x'.repeat(2000) })
  writeFileSync(path, text(email))
  return { configDir, path, text, name: 'fallback@example.test (Pro)' }
}
function stableClock() {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
  spies.push(clock)
  return clock
}

test('unchanged identity files are read and parsed once, retaining only their scalar email', () => {
  stableClock()
  const f = fixture('First@Example.Test')
  const reads = spyOn(fs, 'readFileSync')
  const parses = spyOn(JSON, 'parse')
  spies.push(reads, parses)
  for (let i = 0; i < 30; i++) expect(cliLoginEmail(f)).toBe('first@example.test')
  expect(reads.mock.calls.filter((call) => String(call[0]) === f.path)).toHaveLength(1)
  expect(parses).toHaveBeenCalledTimes(1)
})

test('missing email results are cached but each caller keeps its current name fallback', () => {
  stableClock()
  const f = fixture(null)
  const parses = spyOn(JSON, 'parse')
  spies.push(parses)
  expect(cliLoginEmail(f)).toBe('fallback@example.test')
  expect(cliLoginEmail({ ...f, name: 'second@example.test (Free)' })).toBe('second@example.test')
  expect(cliLoginEmail({ ...f, name: 'No address' })).toBeNull()
  expect(parses).toHaveBeenCalledTimes(1)
})

test('recent timestamps are re-read until stable and catch a same-size change', () => {
  const f = fixture()
  const st = statSync(f.path)
  const clock = spyOn(Date, 'now').mockReturnValue(Math.max(st.mtimeMs, st.ctimeMs) + 100)
  const parses = spyOn(JSON, 'parse')
  spies.push(clock, parses)
  expect(cliLoginEmail(f)).toBe('first@example.test')
  writeFileSync(f.path, f.text('other@example.test'))
  utimesSync(f.path, st.atime, st.mtime)
  expect(cliLoginEmail(f)).toBe('other@example.test')
  expect(parses).toHaveBeenCalledTimes(2)
  clock.mockReturnValue(Date.now() + 10_000)
  expect(cliLoginEmail(f)).toBe('other@example.test')
  expect(cliLoginEmail(f)).toBe('other@example.test')
  expect(parses).toHaveBeenCalledTimes(3)
})

test('replacement, deletion, corrupt bytes and repair never return a stale identity', () => {
  stableClock()
  const f = fixture()
  expect(cliLoginEmail(f)).toBe('first@example.test')
  const st = statSync(f.path)
  const replacement = join(f.configDir, 'replacement.json')
  writeFileSync(replacement, f.text('other@example.test'))
  utimesSync(replacement, st.atime, st.mtime)
  expect(statSync(replacement).size).toBe(st.size)
  renameSync(replacement, f.path)
  expect(cliLoginEmail(f)).toBe('other@example.test')
  rmSync(f.path)
  expect(cliLoginEmail(f)).toBe('fallback@example.test')
  writeFileSync(f.path, '{malformed')
  expect(cliLoginEmail(f)).toBe('fallback@example.test')
  expect(readFileSync(f.path, 'utf8')).toBe('{malformed')
  writeFileSync(f.path, f.text('fixed@example.test'))
  expect(cliLoginEmail(f)).toBe('fixed@example.test')
})

test('unreadable metadata invalidates a prior hit and retries after the read recovers', () => {
  stableClock()
  const f = fixture()
  expect(cliLoginEmail(f)).toBe('first@example.test')
  const real = fs.statSync
  const stats = spyOn(fs, 'statSync').mockImplementation(((
    ...args: Parameters<typeof fs.statSync>
  ) => {
    if (String(args[0]) === f.path)
      throw Object.assign(new Error('Synthetic refusal'), { code: 'EACCES' })
    return Reflect.apply(real, fs, args)
  }) as typeof fs.statSync)
  spies.push(stats)
  expect(cliLoginEmail(f)).toBe('fallback@example.test')
  stats.mockRestore()
  const parses = spyOn(JSON, 'parse')
  spies.push(parses)
  expect(cliLoginEmail(f)).toBe('first@example.test')
  expect(parses).toHaveBeenCalledTimes(1)
})

test('different folders and existing email normalization keep their previous behavior', () => {
  stableClock()
  const first = fixture(' Spaced@Example.Test ')
  const second = fixture('other@example.test')
  expect(cliLoginEmail(first)).toBe(' spaced@example.test ')
  expect(cliLoginEmail(second)).toBe('other@example.test')
  writeFileSync(first.path, first.text(123))
  expect(cliLoginEmail(first)).toBe('fallback@example.test')
  expect(cliLoginEmail(second)).toBe('other@example.test')
})

test('the bounded cache evicts old paths rather than retaining every account ever seen', () => {
  stableClock()
  const f = fixture()
  expect(cliLoginEmail(f)).toBe('first@example.test')
  for (let i = 0; i < 512; i++) {
    const configDir = join(f.configDir, `account-${i}`)
    mkdirSync(configDir)
    writeFileSync(join(configDir, '.claude.json'), f.text('other@example.test'))
    expect(cliLoginEmail({ configDir, name: 'Example' })).toBe('other@example.test')
  }
  const parses = spyOn(JSON, 'parse')
  spies.push(parses)
  expect(cliLoginEmail(f)).toBe('first@example.test')
  expect(parses).toHaveBeenCalledTimes(1)
}, 30_000)

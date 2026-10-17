import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '../src/config'
import { getCliInstance, isLoggedIn } from '../src/core/cli-instances'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const fixture = () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ah-empty-login-'))
  dirs.push(dir)
  const file = join(dir, '.credentials.json')
  const write = (oauth: Record<string, unknown>) =>
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }))
  return { dir, file, write }
}

test('a cleared OAuth credential does not count as signed in just because the file exists', () => {
  const f = fixture()
  f.write({ accessToken: '', refreshToken: '', expiresAt: 0 })
  expect(isLoggedIn(f.dir)).toBe(false)
  f.write({ accessToken: '  ', refreshToken: '\t', expiresAt: Date.now() + 3_600_000 })
  expect(isLoggedIn(f.dir)).toBe(false)
})

test('normal renewal and removal immediately replace the cached empty state', () => {
  const f = fixture()
  f.write({ accessToken: '', refreshToken: '', expiresAt: 0 })
  expect(isLoggedIn(f.dir)).toBe(false)
  f.write({ accessToken: 'synthetic-current', refreshToken: '', expiresAt: Date.now() + 3_600_000 })
  expect(isLoggedIn(f.dir)).toBe(true)
  fs.rmSync(f.file)
  expect(isLoggedIn(f.dir)).toBe(false)
  f.write({ accessToken: '', refreshToken: 'synthetic-refresh', expiresAt: 0 })
  expect(isLoggedIn(f.dir)).toBe(true)
})

test('a cleared login retains its exact identity so renewal updates the existing managed entry', () => {
  const f = fixture()
  const registry = join(CONFIG_DIR, 'cli-instances.json')
  const previous = fs.existsSync(registry) ? fs.readFileSync(registry) : null
  const id = '11111111-1111-4111-8111-111111111111'
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(
      registry,
      JSON.stringify({ instances: [{ id, name: 'Synthetic account', configDir: f.dir }] }),
    )
    fs.writeFileSync(
      join(f.dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'account@example.test' } }),
    )
    f.write({ accessToken: '', refreshToken: '', expiresAt: 0 })
    expect(getCliInstance(id)).toMatchObject({
      id,
      loggedIn: false,
      accountEmail: 'account@example.test',
    })
  } finally {
    if (previous) fs.writeFileSync(registry, previous)
    else fs.rmSync(registry, { force: true })
  }
})

test('an expired access token with a refresh token and unknown legacy formats keep their previous semantics', () => {
  const f = fixture()
  for (const oauth of [
    { accessToken: 'synthetic-old', refreshToken: 'synthetic-refresh', expiresAt: 0 },
    { accessToken: 'synthetic-old', expiresAt: 0 },
    {},
  ]) {
    f.write(oauth)
    expect(isLoggedIn(f.dir)).toBe(true)
  }
  fs.writeFileSync(f.file, '{}')
  expect(isLoggedIn(f.dir)).toBe(true)
})

test('unchanged credentials reuse the value-blind projection without reading token bytes again', () => {
  const f = fixture()
  f.write({ accessToken: '', refreshToken: '', expiresAt: 0 })
  const realNow = Date.now
  const stat = fs.statSync(f.file)
  Date.now = () => Math.max(stat.mtimeMs, stat.ctimeMs) + 2_000
  try {
    expect(isLoggedIn(f.dir)).toBe(false)
    // A warm cache should work with its value-only record even while the payload cannot be read.
    const mock = spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('Unexpected credential re-read')
    })
    try {
      expect(isLoggedIn(f.dir)).toBe(false)
      expect(mock).not.toHaveBeenCalled()
    } finally {
      mock.mockRestore()
    }
  } finally {
    Date.now = realNow
  }
})

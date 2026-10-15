import { afterAll, beforeAll, describe as group, expect, test } from 'bun:test'
import { testHome } from '../home.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DISCOVER = pathToFileURL(path.resolve(import.meta.dir, '../../lib/static/discover.mjs')).href
let dir
let home

const git = (...args) => execFileSync('git', ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', ...args], { cwd: dir, stdio: 'ignore' })
const put = (file, text = '<template><p>Hi</p></template>\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
}
// A fresh process each time: walk() remembers a root for the life of its process, so the cache is only seen by the next one.
const walkNow = () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { walk } from '${DISCOVER}'; console.log(JSON.stringify(walk(${JSON.stringify(dir)})))`], {
    encoding: 'utf8',
    env: { ...process.env, PRICECHECK_HOME: home },
  })
  return JSON.parse(r.stdout)
}
const cacheFiles = () => {
  const d = path.join(home, 'walk-cache')
  return fs.existsSync(d) ? fs.readdirSync(d).map((n) => path.join(d, n)) : []
}
const fakeEntry = (name) => {
  const [file] = cacheFiles()
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
  entry.cached.push(name)
  fs.writeFileSync(file, JSON.stringify(entry))
}

beforeAll(() => {
  home = testHome()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-walk-'))
  put('src/views/A.vue')
  put('src/components/B.vue')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

group('the file listing is cached under PRICECHECK_HOME and never stale', () => {
  test('the first run writes the cache under the test home, the second run reads it', () => {
    expect(walkNow()).toEqual(['src/components/B.vue', 'src/views/A.vue'])
    expect(cacheFiles().length).toBe(1)
    expect(cacheFiles()[0].startsWith(home)).toBe(true)
    fakeEntry('src/zz/FromCache.vue')
    expect(walkNow()).toContain('src/zz/FromCache.vue')
  })

  test('a new untracked file is seen even on a cache hit', () => {
    put('src/views/New.vue')
    const files = walkNow()
    expect(files).toContain('src/views/New.vue')
    expect(files).toContain('src/zz/FromCache.vue')
  })

  test('a changed index (git add of the new file) drops the cache and lists the live files', () => {
    git('add', 'src/views/New.vue')
    const files = walkNow()
    expect(files).toContain('src/views/New.vue')
    expect(files).not.toContain('src/zz/FromCache.vue')
  })

  test('a tracked file removed from the index is gone from the next listing', () => {
    fakeEntry('src/zz/Again.vue')
    git('rm', '-q', '--cached', 'src/components/B.vue')
    fs.rmSync(path.join(dir, 'src/components/B.vue'))
    const files = walkNow()
    expect(files).not.toContain('src/components/B.vue')
    expect(files).not.toContain('src/zz/Again.vue')
  })

  test('a commit that leaves the index as it was still serves a listing equal to the live one', () => {
    git('commit', '-qm', 'second')
    const cached = walkNow()
    fs.rmSync(path.join(home, 'walk-cache'), { recursive: true, force: true })
    expect(walkNow()).toEqual(cached)
  })

  test('the cache keeps at most 64 listings', () => {
    const d = path.join(home, 'walk-cache')
    for (const f of cacheFiles()) fs.rmSync(f)
    fs.mkdirSync(d, { recursive: true })
    for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(d, `old-${i}.json`), '{}')
    walkNow()
    expect(cacheFiles().length).toBeLessThanOrEqual(64)
  })
})

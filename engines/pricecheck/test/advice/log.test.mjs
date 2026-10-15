import { afterEach, beforeEach, describe as group, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  adviceFile,
  appendRow,
  callsFile,
  gitHead,
  homeDir,
  newId,
  pricecheckVersion,
  readRows,
  recordAdvice,
  recordAdvices,
  recordCall,
} from '../../lib/advice/log.mjs'

const ROOT = path.resolve('C:/Users/me/Projects/example-shop')
const dirs = []

let home
let previous

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  previous = process.env.PRICECHECK_HOME
  home = tempDir('pricecheck-log-')
  process.env.PRICECHECK_HOME = home
})

afterEach(() => {
  if (previous === undefined) delete process.env.PRICECHECK_HOME
  else process.env.PRICECHECK_HOME = previous
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const blockedHome = () => {
  const blocked = path.join(home, 'not-a-folder')
  fs.writeFileSync(blocked, 'x')
  return blocked
}

group('the store', () => {
  test('lives in PRICECHECK_HOME as advice.jsonl and calls.jsonl', () => {
    expect(homeDir()).toBe(home)
    expect(adviceFile()).toBe(path.join(home, 'advice.jsonl'))
    expect(callsFile()).toBe(path.join(home, 'calls.jsonl'))
  })

  test('readRows is empty with no file, and skips an empty line or one that does not parse', () => {
    expect(readRows(adviceFile())).toEqual([])
    fs.writeFileSync(adviceFile(), '{"type":"advice","id":"a"}\n{"not closed\n\n{"type":"outcome"}\n')
    expect(readRows(adviceFile()).map((r) => r.type)).toEqual(['advice', 'outcome'])
  })

  test('appendRow only appends one JSON line per row, and throws when the home is unwritable', () => {
    appendRow(adviceFile(), { type: 'a' })
    appendRow(adviceFile(), { type: 'b' })
    expect(fs.readFileSync(adviceFile(), 'utf8')).toBe('{"type":"a"}\n{"type":"b"}\n')
    expect(() => appendRow(path.join(blockedHome(), 'advice.jsonl'), { type: 'c' })).toThrow()
  })
})

group('ids and versions', () => {
  test('newId is 8 lowercase hex characters and differs between calls', () => {
    const a = newId()
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(newId()).not.toBe(a)
  })

  test('pricecheckVersion is a 12-character hex hash that stays the same within a process', () => {
    const v = pricecheckVersion()
    expect(v).toMatch(/^[0-9a-f]{12}$/)
    expect(pricecheckVersion()).toBe(v)
  })

  test('gitHead is null outside a repo and the HEAD commit inside one', () => {
    expect(gitHead(home)).toBeNull()
    const repo = tempDir('pricecheck-git-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: repo })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(gitHead(repo)).toBe(head)
  })
})

group('recordAdvice', () => {
  test('appends an advice row with its page, points, files, claim, version and repo', () => {
    const id = recordAdvice({
      kind: 'next',
      root: ROOT,
      page: 'src/views/Landing.vue',
      points: 40,
      files: [{ file: 'src/views/Landing.vue', points: 30 }],
      claim: 'cut Landing from 40 points',
    })
    expect(id).toMatch(/^[0-9a-f]{8}$/)
    const [row] = readRows(adviceFile())
    expect(row).toMatchObject({
      type: 'advice',
      id,
      kind: 'next',
      root: ROOT,
      repo: 'example-shop',
      page: 'src/views/Landing.vue',
      points: 40,
      files: [{ file: 'src/views/Landing.vue', points: 30 }],
      claim: 'cut Landing from 40 points',
      version: pricecheckVersion(),
    })
    expect(Number.isNaN(Date.parse(row.at))).toBe(false)
  })

  test('takes the id it is given, so a brief can carry the id it was written under', () => {
    expect(recordAdvice({ id: 'abc12345', kind: 'next', root: ROOT, claim: 'x' })).toBe('abc12345')
    expect(readRows(adviceFile())[0].id).toBe('abc12345')
  })

  test('leaves page, points and files out of a row that has none', () => {
    recordAdvice({ kind: 'check', root: ROOT, claim: 'stale entry' })
    const [row] = readRows(adviceFile())
    expect(row).not.toHaveProperty('page')
    expect(row).not.toHaveProperty('points')
    expect(row).not.toHaveProperty('files')
  })

  test('recordAdvices writes one row per item and reads the head once for all of them', () => {
    const repo = tempDir('pricecheck-batch-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: repo })
    const ids = recordAdvices([
      { kind: 'diff', root: repo, page: 'src/views/A.vue', points: 10, claim: 'a' },
      { kind: 'diff', root: repo, page: 'src/views/B.vue', points: 20, claim: 'b' },
    ])
    expect(ids).toHaveLength(2)
    const rows = readRows(adviceFile())
    expect(rows.map((r) => r.page)).toEqual(['src/views/A.vue', 'src/views/B.vue'])
    expect(rows[0].head).toMatch(/^[0-9a-f]{40}$/)
    expect(rows[1].head).toBe(rows[0].head)
  })

  test('never throws when the home is unwritable, and still returns the id', () => {
    process.env.PRICECHECK_HOME = blockedHome()
    expect(recordAdvice({ kind: 'tag', root: ROOT, claim: 'x' })).toMatch(/^[0-9a-f]{8}$/)
    expect(recordAdvices([{ kind: 'tag', root: ROOT, claim: 'y' }])).toHaveLength(1)
  })

  test('recordAdvices records nothing for an item at zero points', () => {
    const ids = recordAdvices([
      { kind: 'check', root: ROOT, page: 'src/views/Landing.vue', points: 0, claim: 'unfrozen src/views/Landing.vue' },
      { kind: 'check', root: ROOT, page: 'src/views/SignIn.vue', points: 12, claim: 'unfrozen src/views/SignIn.vue' },
    ])
    expect(ids).toHaveLength(1)
    expect(readRows(adviceFile()).map((r) => r.page)).toEqual(['src/views/SignIn.vue'])
  })
})

group('recordCall', () => {
  test('appends one row per run with its command, args, root, ms, exit and version', () => {
    recordCall({ cmd: 'scan', args: ['--json', '--root', ROOT], ms: 12, exit: 0 })
    recordCall({ cmd: 'check', args: [], ms: 3, exit: 1 })
    const [a, b] = readRows(callsFile())
    expect(a).toEqual({ at: a.at, cmd: 'scan', args: ['--json', '--root', ROOT], root: ROOT, ms: 12, exit: 0, version: pricecheckVersion() })
    expect(b).toMatchObject({ cmd: 'check', root: path.resolve(process.cwd()), ms: 3, exit: 1 })
  })

  test('never throws when the home is unwritable', () => {
    process.env.PRICECHECK_HOME = blockedHome()
    expect(() => recordCall({ cmd: 'scan', args: [], ms: 1, exit: 0 })).not.toThrow()
  })
})

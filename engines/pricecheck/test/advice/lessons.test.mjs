import '../home.mjs'
import './lessons-home.mjs'
import { afterEach, beforeEach, describe as group, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adviceFile, appendRow } from '../../lib/advice/log.mjs'
import { reconcile } from '../../lib/advice/reconcile.mjs'
import { historyFile } from '../../lib/history.mjs'
import { lessonsDir, readLessons, recordLesson, sharedView } from '../../lib/advice/lessons.mjs'
import { run } from '../../lib/advice/cli.mjs'
import { priceCheckTools } from '../../mcp/tools.mjs'

const PRICECHECK_TOOLS = priceCheckTools()

const ROOT = 'C:/Users/someone/Project/app'
let dir
let prev

beforeEach(() => {
  prev = { l: process.env.PRICECHECK_LESSONS_DIR, m: process.env.PRICECHECK_MACHINE }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lessons-'))
  process.env.PRICECHECK_LESSONS_DIR = dir
  process.env.PRICECHECK_MACHINE = 'Brother PC'
  fs.rmSync(adviceFile(), { force: true })
  fs.rmSync(historyFile(), { force: true })
})

afterEach(() => {
  for (const [k, v] of [['PRICECHECK_LESSONS_DIR', prev.l], ['PRICECHECK_MACHINE', prev.m]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const advice = (over = {}) => ({
  type: 'advice', id: 'a1', at: '2026-10-01T00:00:00.000Z', kind: 'next', root: ROOT, repo: 'app',
  page: 'src/views/Checkout.vue', points: 40, claim: 'trim checkout', version: 'v1', head: null,
  files: [{ file: `${ROOT}/src/views/Checkout.vue`, points: 30 }], ...over,
})
const snap = (at, version, points) =>
  appendRow(historyFile(), { at, root: path.resolve(ROOT), repo: 'app', mode: 'static', total: points, pages: [{ page: 'src/views/Checkout.vue', points, units: {} }], version, head: null })
const lessonText = () => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('')
const quiet = () => spyOn(console, 'log').mockImplementation(() => {})

group('lessons', () => {
  test('the folder is the override, and the machine name is a safe lowercase file name', () => {
    expect(lessonsDir()).toBe(dir)
    recordLesson({ id: 'f1', kind: 'wrong', claim: 'x' })
    expect(fs.readdirSync(dir)).toEqual(['brother-pc.jsonl'])
  })

  test('without an override the folder is the package lessons folder', () => {
    delete process.env.PRICECHECK_LESSONS_DIR
    expect(lessonsDir().split(path.sep).slice(-2)).toEqual(['pricecheck', 'lessons'])
  })

  test('an undone outcome written by reconcile lands as a lesson row', () => {
    appendRow(adviceFile(), advice())
    snap('2026-10-02T00:00:00.000Z', 'v1', 25)
    snap('2026-10-03T00:00:00.000Z', 'v1', 45)
    reconcile(ROOT, { now: Date.parse('2026-10-04T00:00:00.000Z') })
    const rows = readLessons()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'undone', machine: 'brother-pc', repo: 'app', page: 'src/views/Checkout.vue',
      points: 40, pointsAfter: 45, claim: 'trim checkout', adviceKind: 'next', version: 'v1', adviceAt: '2026-10-01T00:00:00.000Z',
      files: ['src/views/Checkout.vue'],
    })
    console.log('sample lesson row:', JSON.stringify(rows[0]))
  })

  test('a misled outcome is a lesson; followed and stale are not', () => {
    appendRow(adviceFile(), advice())
    appendRow(adviceFile(), advice({ id: 'a2' }))
    snap('2026-10-02T00:00:00.000Z', 'v2', 50)
    reconcile(ROOT, { now: Date.parse('2026-10-04T00:00:00.000Z') })
    expect(readLessons().map((r) => r.kind)).toEqual(['misled', 'misled'])
  })

  test('followed and stale outcomes are not lessons', () => {
    appendRow(adviceFile(), advice())
    appendRow(adviceFile(), advice({ id: 'a2', page: 'src/views/Other.vue' }))
    snap('2026-10-02T00:00:00.000Z', 'v1', 10)
    reconcile(ROOT, { now: Date.parse('2026-10-04T00:00:00.000Z') })
    reconcile(ROOT, { now: Date.parse('2027-03-04T00:00:00.000Z') })
    expect(readLessons()).toHaveLength(0)
  })

  test('re-running reconcile never writes the same lesson twice', () => {
    appendRow(adviceFile(), advice())
    snap('2026-10-02T00:00:00.000Z', 'v1', 45)
    reconcile(ROOT)
    reconcile(ROOT)
    expect(readLessons()).toHaveLength(1)
  })

  test('feedback wrong and undone are lessons, right is not, with or without an adviceId', async () => {
    appendRow(adviceFile(), advice({ root: path.resolve(ROOT) }))
    const log = quiet()
    await run(['feedback', '--root', ROOT, '--verdict', 'wrong', '--claim', 'bad number', '--why', 'counted a hidden menu', '--advice', 'a1'])
    await run(['feedback', '--root', ROOT, '--verdict', 'undone', '--claim', 'loose one'])
    await run(['feedback', '--root', ROOT, '--verdict', 'right', '--claim', 'fine'])
    log.mockRestore()
    const rows = readLessons()
    expect(rows.map((r) => r.kind)).toEqual(['wrong', 'undone-feedback'])
    expect(rows[0]).toMatchObject({ claim: 'bad number', why: 'counted a hidden menu', repo: 'app', page: 'src/views/Checkout.vue', points: 40, adviceKind: 'next' })
    expect(rows[1].why).toBeUndefined()
  })

  test('the same id and kind is written once', () => {
    recordLesson({ id: 'f1', kind: 'wrong', claim: 'x' })
    recordLesson({ id: 'f1', kind: 'wrong', claim: 'x' })
    recordLesson({ id: 'f1', kind: 'undone-feedback', claim: 'x' })
    expect(readLessons()).toHaveLength(2)
  })

  test('no absolute path or home path lands in a lesson file', async () => {
    appendRow(adviceFile(), advice())
    snap('2026-10-02T00:00:00.000Z', 'v1', 45)
    reconcile(ROOT)
    const log = quiet()
    await run(['feedback', '--root', ROOT, '--verdict', 'wrong', '--claim', 'c', '--advice', 'a1'])
    log.mockRestore()
    const text = lessonText()
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain('C:/Users')
    expect(text).not.toContain('C:\\\\Users')
    expect(text).not.toContain('someone')
  })

  test('a failed lesson write never throws', () => {
    const blocker = path.join(dir, 'a-file')
    fs.writeFileSync(blocker, 'x')
    process.env.PRICECHECK_LESSONS_DIR = blocker
    expect(() => recordLesson({ id: 'f1', kind: 'wrong', claim: 'x' })).not.toThrow()
  })

  test('shared view: newest first, grouped by repo, with a tally per machine', () => {
    const put = (machine, rows) => fs.writeFileSync(path.join(dir, `${machine}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
    put('pc-a', [{ id: '1', at: '2026-10-01T00:00:00.000Z', machine: 'pc-a', repo: 'app', kind: 'undone', page: 'p', points: 40, pointsAfter: 45, claim: 'c1', why: 'w' }])
    put('pc-b', [
      { id: '2', at: '2026-10-02T00:00:00.000Z', machine: 'pc-b', repo: 'app', kind: 'wrong', claim: 'c2' },
      { id: '3', at: '2026-10-03T00:00:00.000Z', machine: 'pc-b', repo: 'other', kind: 'misled', claim: 'c3' },
    ])
    const view = sharedView()
    expect(view.lessons.map((r) => r.id)).toEqual(['3', '2', '1'])
    expect(view.tally).toEqual({ 'pc-a': 1, 'pc-b': 2 })
    expect(view.lines.some((l) => l.includes('pc-a') && l.includes('undone') && l.includes('40 -> 45') && l.includes('c1'))).toBe(true)
    expect(view.lines.at(-1)).toContain('pc-b 2')
  })

  test('advice --shared prints them and --shared --json gives the rows', async () => {
    recordLesson({ id: 'f1', kind: 'wrong', claim: 'seen', repo: 'app' })
    const out = []
    const log = spyOn(console, 'log').mockImplementation((s) => out.push(s))
    expect(await run(['advice', '--shared'])).toBe(0)
    expect(out.join('\n')).toContain('seen')
    out.length = 0
    expect(await run(['advice', '--shared', '--json'])).toBe(0)
    log.mockRestore()
    expect(JSON.parse(out.join('\n')).lessons[0].claim).toBe('seen')
  })

  test('price_check_advice takes shared: true', async () => {
    recordLesson({ id: 'f1', kind: 'wrong', claim: 'seen', repo: 'app' })
    const tool = PRICECHECK_TOOLS.find((t) => t.name === 'price_check_advice')
    expect(tool.inputSchema.properties.shared).toBeDefined()
    expect(tool.description).toContain('shared')
    const out = await tool.run({ shared: true })
    expect(out.lessons[0].claim).toBe('seen')
    expect(PRICECHECK_TOOLS).toHaveLength(7)
  })
})

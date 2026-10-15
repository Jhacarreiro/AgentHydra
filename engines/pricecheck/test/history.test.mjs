import { afterEach, beforeEach, describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { historyFile, progress, readHistory, recordScan } from '../lib/history.mjs'
import { PRICE_LIST_VERSION } from '../lib/model.mjs'
import { pricecheckVersion } from '../lib/advice/log.mjs'

const ROOT = path.resolve('C:/Users/me/Projects/example-shop')
const OTHER = path.resolve('C:/Users/me/Projects/example-blog')

const scan = (pages, root = ROOT) => ({ root, mode: 'static', pages })
const landing = (points, words) => ({ page: 'src/views/Landing.vue', points, units: { word: words } })
const signIn = (points, controls) => ({ page: 'src/views/SignIn.vue', points, units: { control: controls } })

let home
let previous

beforeEach(() => {
  previous = process.env.PRICECHECK_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pricecheck-history-'))
  process.env.PRICECHECK_HOME = home
})

afterEach(() => {
  if (previous === undefined) delete process.env.PRICECHECK_HOME
  else process.env.PRICECHECK_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
})

group('recordScan', () => {
  test('appends one line per changed scan, into PRICECHECK_HOME', () => {
    recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z')
    expect(historyFile()).toBe(path.join(home, 'history.jsonl'))
    const lines = fs.readFileSync(historyFile(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const snap = JSON.parse(lines[0])
    expect(snap).toMatchObject({ at: '2026-10-01T09:00:00.000Z', repo: 'example-shop', mode: 'static', total: 40 })
    expect(snap.pages).toEqual([{ page: 'src/views/Landing.vue', points: 40, units: { word: 20 } }])
  })

  test('skips a scan identical to the repo\'s last snapshot, but not another repo\'s', () => {
    expect(recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z').written).toBe(true)
    expect(recordScan(scan([landing(40, 20)]), '2026-10-02T09:00:00.000Z').written).toBe(false)
    expect(recordScan(scan([landing(40, 20)], OTHER), '2026-10-02T09:00:00.000Z').written).toBe(true)
    expect(readHistory(ROOT)).toHaveLength(1)
    expect(readHistory(OTHER)).toHaveLength(1)
  })

  test('a change in one page\'s units is a new snapshot even when the total is the same', () => {
    recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z')
    expect(recordScan(scan([landing(40, 19)]), '2026-10-02T09:00:00.000Z').written).toBe(true)
  })

  test('each snapshot carries the pricecheck version and the repo head, which is null outside git', () => {
    recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z')
    const snap = readHistory(ROOT)[0]
    expect(snap.version).toMatch(/^[0-9a-f]{12}$/)
    expect(snap.head === null || /^[0-9a-f]{40}$/.test(snap.head)).toBe(true)
  })

  test('a scan identical in pages but recorded under another version is a new snapshot', () => {
    const row = { at: '2026-10-01T09:00:00.000Z', root: ROOT, repo: 'example-shop', mode: 'static', total: 40, pages: [{ page: 'src/views/Landing.vue', points: 40, units: { word: 20 } }], version: '000000000000', head: null }
    fs.appendFileSync(historyFile(), `${JSON.stringify(row)}\n`)
    expect(recordScan(scan([landing(40, 20)]), '2026-10-02T09:00:00.000Z').written).toBe(true)
    expect(readHistory(ROOT)).toHaveLength(2)
  })

  test('each snapshot is stamped with the price list it was priced under', () => {
    recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z')
    expect(readHistory(ROOT)[0].priceList).toBe(PRICE_LIST_VERSION)
  })

  test('a scan identical in pages but priced under an unstamped (price list 1) snapshot is a new snapshot', () => {
    const row = { at: '2026-10-01T09:00:00.000Z', root: ROOT, repo: 'example-shop', mode: 'static', total: 40, pages: [{ page: 'src/views/Landing.vue', points: 40, units: { word: 20 } }], version: pricecheckVersion(), head: null }
    fs.appendFileSync(historyFile(), `${JSON.stringify(row)}\n`)
    expect(recordScan(scan([landing(40, 20)]), '2026-10-02T09:00:00.000Z').written).toBe(true)
  })
})

group('readHistory', () => {
  test('is empty before any scan, and skips a line that does not parse', () => {
    expect(readHistory(ROOT)).toEqual([])
    recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z')
    fs.appendFileSync(historyFile(), '{"not closed\n')
    recordScan(scan([landing(30, 15)]), '2026-10-02T09:00:00.000Z')
    expect(readHistory(ROOT).map((s) => s.total)).toEqual([40, 30])
  })
})

group('progress', () => {
  test('is null with no history', () => {
    expect(progress(ROOT)).toBeNull()
  })

  test('reports the points saved since the first snapshot, the pages that got cheaper, and the units that fell', () => {
    recordScan(scan([landing(40, 20), signIn(20, 4)]), '2026-10-01T09:00:00.000Z')
    recordScan(scan([landing(25, 12), signIn(20, 2)]), '2026-10-05T09:00:00.000Z')
    const p = progress(ROOT)
    expect(p.first).toEqual({ at: '2026-10-01T09:00:00.000Z', total: 60 })
    expect(p.now).toEqual({ at: '2026-10-05T09:00:00.000Z', total: 45 })
    expect(p.dropped).toBe(15)
    expect(p.pagesCheaper).toBe(1)
    expect(p.biggestDrops).toEqual([{ page: 'src/views/Landing.vue', from: 40, to: 25 }])
    expect(p.unitsFell).toEqual({ word: 8, control: 2 })
  })

  test('a rise shows as negative points saved', () => {
    recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z')
    recordScan(scan([landing(50, 25)]), '2026-10-02T09:00:00.000Z')
    expect(progress(ROOT).dropped).toBe(-10)
    expect(progress(ROOT).unitsFell).toEqual({})
  })

  test('compares only snapshots under the current price list, and says the list changed when older snapshots precede them', () => {
    const older = { at: '2026-10-01T09:00:00.000Z', root: ROOT, repo: 'example-shop', mode: 'static', total: 153450, pages: [{ page: 'src/views/Landing.vue', points: 153450, units: { word: 1 } }], version: '000000000000', head: null }
    fs.appendFileSync(historyFile(), `${JSON.stringify(older)}\n`)
    recordScan(scan([landing(40, 20)]), '2026-10-05T09:00:00.000Z')
    recordScan(scan([landing(30, 15)]), '2026-10-06T09:00:00.000Z')
    const p = progress(ROOT)
    expect(p.first).toEqual({ at: '2026-10-05T09:00:00.000Z', total: 40 })
    expect(p.now).toEqual({ at: '2026-10-06T09:00:00.000Z', total: 30 })
    expect(p.dropped).toBe(10)
    expect(p.list).toBe(PRICE_LIST_VERSION)
    expect(p.listChanged).toBe(true)
  })

  test('is null when only one snapshot is under the current price list', () => {
    const older = { at: '2026-10-01T09:00:00.000Z', root: ROOT, repo: 'example-shop', mode: 'static', total: 153450, pages: [], version: '000000000000', head: null }
    fs.appendFileSync(historyFile(), `${JSON.stringify(older)}\n`)
    recordScan(scan([landing(40, 20)]), '2026-10-05T09:00:00.000Z')
    expect(progress(ROOT)).toBeNull()
  })

  test('says nothing about a list change when the first snapshot is under the current price list', () => {
    recordScan(scan([landing(40, 20)]), '2026-10-01T09:00:00.000Z')
    recordScan(scan([landing(30, 15)]), '2026-10-02T09:00:00.000Z')
    expect(progress(ROOT).listChanged).toBe(false)
  })
})

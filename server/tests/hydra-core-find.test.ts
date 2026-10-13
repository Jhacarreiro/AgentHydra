import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { loadCatalog } from '../src/hydra-core/catalog'
import { findPage, matchOf } from '../src/hydra-core/find'
import { findTool } from '../src/hydra-core/tree'
import { scratch } from './hydra-core-fixture'

let dir = ''
beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const entries = () => [...loadCatalog(dir).entries.values()]

test('the entry whose tags and when match the need ranks first', () => {
  const r = findPage(entries(), 'dashboard layout')
  expect(r.ids).toEqual(['person:iris-ui', 'knowledge:brand-notes'])
  expect(r.total).toBe(2)
})

test('a kind filter keeps only that kind', () => {
  expect(findPage(entries(), 'dashboard', { kinds: ['knowledge'] }).ids).toEqual([
    'knowledge:brand-notes',
  ])
})

test('a mode filter keeps only people who allow that mode', () => {
  expect(findPage(entries(), 'release', { mode: 'consult' }).ids).toEqual([])
  expect(findPage(entries(), 'release', { mode: 'become' }).ids).toEqual(['person:ops-lead'])
})

test('an empty need finds nothing', () => {
  expect(findPage(entries(), '   ')).toEqual({ ids: [], total: 0 })
})

test('paging returns the next slice of the same ranking', () => {
  const r = findPage(entries(), 'dashboard layout', { start: 1, limit: 1 })
  expect(r).toEqual({ ids: ['knowledge:brand-notes'], total: 2 })
})

test('a match carries no load, so the file path or call stays out of the find page', () => {
  const m = matchOf(loadCatalog(dir).entries.get('instrument:screen-capture')!)
  expect(m).not.toHaveProperty('load')
  expect(m.how).toBe('run the capture tool on a url')
})

test('findTool returns matches and says whether a next page exists', () => {
  const r = findTool(dir, { need: 'dashboard layout', chat: 'chat-example-find' })
  expect(r.matches.map((m) => m.id)).toEqual(['person:iris-ui', 'knowledge:brand-notes'])
  expect(r.more).toBe(false)
})

test('findTool refuses an unknown kind', () => {
  expect(() => findTool(dir, { need: 'dashboard', kind: 'boss' })).toThrow('kind must be one of')
})

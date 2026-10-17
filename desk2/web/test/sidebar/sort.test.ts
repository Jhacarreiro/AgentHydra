import { expect, test } from 'bun:test'
import type { SidebarEntry, SidebarGroups } from '../../src/components/sidebar/logic'
import { entryKey, sortGroups } from '../../src/components/sidebar/logic'
import { SORT_VALUES, sortRows, useSidebarSort, type RowFacts, type SidebarSort } from '../../src/components/sidebar/sort'

// Invented rows: a title, when each started, and its last activity. The sort reads only these facts.
const FACTS: Record<string, RowFacts> = {
  b: { title: 'Beta', started: 300, activity: 900 },
  a: { title: 'alpha', started: 100, activity: 500 },
  c: { title: 'Chapter 10', started: 200, activity: 700 },
  d: { title: 'Chapter 2', started: null, activity: 800 },
  e: { title: 'Chapter 1', started: null, activity: 100 }
}
const facts = (id: string) => FACTS[id]!
const ids = (mode: SidebarSort, list = Object.keys(FACTS)) => sortRows(list, mode, facts)

// A desk row, as sidebar/logic.ts holds it: an id, its last activity, and the top row it sits under (nestChildren).
const entry = (id: string, under?: string): SidebarEntry => ({ kind: 'chat', id, at: FACTS[id]?.activity ?? 0, under, chat: {} }) as unknown as SidebarEntry
const group = (key: string, entries: SidebarEntry[]) => ({ key, label: key, cwd: null, entries })
const groupsOf = (folders: SidebarEntry[][]): SidebarGroups => ({
  pinned: null,
  folders: folders.map((list, i) => group(`folder-${i}`, list)),
  archived: null,
  hiddenOut: 0
})
const rowIds = (g: SidebarGroups) => g.folders.map((f) => f.entries.map((e) => e.id))
const sortOf = (g: SidebarGroups, mode: SidebarSort) => sortGroups(g, mode, (e) => facts(e.id))

test('the default is the date started, and rows list oldest first', () => {
  expect(useSidebarSort().sort.value).toBe('started')
  expect(SORT_VALUES).toEqual(['started', 'name', 'activity', 'manual'])
  // Rows with no start time go after the ones that have one, by title.
  expect(ids('started')).toEqual(['a', 'c', 'b', 'e', 'd'])
})

test('name sorts A-Z, ignoring case and reading numbers in number order', () => {
  expect(ids('name')).toEqual(['a', 'b', 'e', 'd', 'c'])
})

test('activity sorts the newest first', () => {
  expect(ids('activity')).toEqual(['b', 'd', 'c', 'a', 'e'])
})

test('ties keep the order they came in, and a name tie goes by start time', () => {
  const same: Record<string, RowFacts> = {
    x: { title: 'Same', started: 20, activity: 1 },
    y: { title: 'same', started: 10, activity: 1 }
  }
  expect(sortRows(['x', 'y'], 'name', (id) => same[id]!)).toEqual(['y', 'x'])
  expect(sortRows(['x', 'y'], 'activity', (id) => same[id]!)).toEqual(['x', 'y'])
  expect(sortRows(['y', 'x'], 'started', (id) => same[id]!)).toEqual(['y', 'x'])
})

test('a nested child stays under its parent after sorting, sorted among its own children', () => {
  // Parent "b" sits at the top between the others; its children c, e and d follow it, sorted in the same mode.
  const groups = groupsOf([[entry('a'), entry('c', 'chat:b'), entry('b'), entry('e', 'chat:b'), entry('d', 'chat:b')]])
  expect(rowIds(sortOf(groups, 'started'))).toEqual([['a', 'b', 'c', 'e', 'd']])
  expect(rowIds(sortOf(groups, 'name'))).toEqual([['a', 'b', 'e', 'd', 'c']])
  expect(rowIds(sortOf(groups, 'activity'))).toEqual([['b', 'd', 'c', 'e', 'a']])
})

test('manual leaves the groups exactly as the saved order gave them', () => {
  const groups = groupsOf([[entry('d'), entry('a', 'chat:d')], [entry('b'), entry('c')]])
  expect(sortOf(groups, 'manual')).toBe(groups)
  expect(sortRows(['d', 'a', 'b'], 'manual', facts)).toEqual(['d', 'a', 'b'])
})

test('the sort keeps the groups in their order', () => {
  const groups = groupsOf([[entry('a')], [entry('b')]])
  expect(sortOf(groups, 'name').folders.map((f) => f.key)).toEqual(['folder-0', 'folder-1'])
  expect(entryKey(entry('a'))).toBe('chat:a')
})

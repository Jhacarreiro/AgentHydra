import { expect, test } from 'bun:test'
import type { CloudSession } from '@shared/protocol'
import { DEFAULT_SCOPES, groupCloud } from '../../src/components/cloud/logic'
import type { SidebarEntry, SidebarGroups } from '../../src/components/sidebar/logic'
import { sortGroups } from '../../src/components/sidebar/logic'
import type { RowFacts, SidebarSort } from '../../src/components/sidebar/sort'

// Invented sessions in one folder, so the desk list and the cloud list each draw them as one group. Each has a
// start (createdAt, null for one) and a last activity; the desk side reads the same numbers.
const ROWS: { title: string; createdAt: number | null; lastActivityAt: number }[] = [
  { title: 'Chapter 10', createdAt: 200, lastActivityAt: 700 },
  { title: 'Beta', createdAt: 300, lastActivityAt: 900 },
  { title: 'alpha', createdAt: 100, lastActivityAt: 500 },
  { title: 'Chapter 2', createdAt: null, lastActivityAt: 800 }
]
const cloudRows: CloudSession[] = ROWS.map((r, i) => ({
  id: `s${i}`,
  title: r.title,
  cwd: 'D:/work/alpha',
  lastCwd: null,
  source: 'claude',
  instance: null,
  lastActivityAt: r.lastActivityAt,
  createdAt: r.createdAt,
  messageCount: 3,
  dispatched: false,
  archived: false,
  fromPc: null,
  model: null,
  effort: null,
  instanceNum: null
}))
// The desk list's rows: the same sessions as chats, read by the same facts.
const deskEntries = cloudRows.map((r) => ({ kind: 'chat', id: r.id, at: r.lastActivityAt, chat: {} }) as unknown as SidebarEntry)
const deskFacts = (e: SidebarEntry): RowFacts => {
  const r = ROWS[cloudRows.findIndex((c) => c.id === e.id)]!
  return { title: r.title, started: r.createdAt, activity: r.lastActivityAt }
}
const deskGroups: SidebarGroups = {
  pinned: null,
  folders: [{ key: 'D:/work/alpha', label: 'alpha', cwd: 'D:/work/alpha', entries: deskEntries }],
  archived: null,
  hiddenOut: 0
}

test('the desk list and the cloud list order the same rows the same way under each mode', () => {
  const expected: Record<Exclude<SidebarSort, 'manual'>, string[]> = {
    started: ['alpha', 'Chapter 10', 'Beta', 'Chapter 2'],
    name: ['alpha', 'Beta', 'Chapter 2', 'Chapter 10'],
    activity: ['Beta', 'Chapter 2', 'Chapter 10', 'alpha']
  }
  for (const mode of ['started', 'name', 'activity'] as const) {
    const cloud = groupCloud(cloudRows, DEFAULT_SCOPES, 'PC', { sort: mode })
    const desk = sortGroups(deskGroups, mode, deskFacts).folders[0]!.entries.map((e) => ROWS[cloudRows.findIndex((c) => c.id === e.id)]!.title)
    expect(cloud.flatMap((g) => g.rows.map((r) => r.title))).toEqual(expected[mode])
    expect(desk).toEqual(expected[mode])
  }
})

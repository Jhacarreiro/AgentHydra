import { describe, expect, test } from 'bun:test'
import type { PeopleStoreStatus } from '../../web/src/components/people/where-types'
import { ago, syncLine, whereView } from '../../web/src/components/people/where-logic'

const status = (over: Partial<PeopleStoreStatus> = {}): PeopleStoreStatus => ({
  home: 'pc',
  crainium: { available: false },
  syncing: false,
  lastSyncAt: null,
  error: null,
  ...over
})
const NOW = Date.parse('2026-01-01T12:00:00Z')

describe('where your people live', () => {
  test('ago says short plain words', () => {
    expect(ago('2026-01-01T11:59:50Z', NOW)).toBe('just now')
    expect(ago('2026-01-01T11:55:00Z', NOW)).toBe('5 min ago')
    expect(ago('2026-01-01T09:00:00Z', NOW)).toBe('3 h ago')
    expect(ago('2025-12-30T12:00:00Z', NOW)).toBe('2 d ago')
  })

  test('the sync line names syncing, never synced and the last time', () => {
    expect(syncLine(status({ syncing: true }), NOW)).toBe('Syncing…')
    expect(syncLine(status(), NOW)).toBe('Not synced yet')
    expect(syncLine(status({ lastSyncAt: '2026-01-01T11:55:00Z' }), NOW)).toBe('Synced 5 min ago')
  })

  test('CrAInium cannot be picked, and shows no sync, until the door answers', () => {
    expect(whereView(status())).toEqual({ canPick: false, showSync: false })
    expect(whereView(status({ crainium: { available: true, owner: 'example', people: 3 } }))).toEqual({ canPick: true, showSync: false })
  })

  test('Sync now shows only on CrAInium with the door answering', () => {
    expect(whereView(status({ home: 'crainium', crainium: { available: true } })).showSync).toBe(true)
    expect(whereView(status({ home: 'crainium', crainium: { available: false, reason: 'away' } })).showSync).toBe(false)
  })
})

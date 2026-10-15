import { describe, expect, test } from 'bun:test'
import type { PeopleStoreStatus } from '@shared/people-store'
import { ago, initialsOf, syncLine, whereView } from '../../src/components/people/where-logic'

const status = (over: Partial<PeopleStoreStatus> = {}): PeopleStoreStatus => ({
  home: 'pc',
  configured: true,
  signedIn: false,
  account: null,
  syncing: false,
  lastSyncAt: null,
  error: null,
  note: null,
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

  test('with no app id Connections cannot be picked and shows no sign-in or sync', () => {
    expect(whereView(status({ configured: false }))).toEqual({ canPick: false, showAccount: false, showSignIn: false, showSync: false })
  })

  test('signed out shows Sign in; signed in on Connections shows the account and Sync now', () => {
    expect(whereView(status({ home: 'connections' }))).toMatchObject({ showSignIn: true, showSync: false })
    const on = whereView(status({ home: 'connections', signedIn: true, account: { name: 'Example Owner', email: 'owner@example.com' } }))
    expect(on).toMatchObject({ showAccount: true, showSignIn: false, showSync: true })
    expect(whereView(status({ signedIn: true, account: { name: 'A B', email: null } })).showSync).toBe(false)
  })

  test('initials of an account name', () => {
    expect(initialsOf('Example Owner')).toBe('EO')
    expect(initialsOf('')).toBe('')
  })
})

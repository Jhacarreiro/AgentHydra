import { describe, expect, it } from 'bun:test'
import { activeInstanceCounts, desktopSignedIn } from './active-instance-counts'

describe('active instance header counts', () => {
  it('counts authenticated availability rather than saved rows or open application windows', () => {
    expect(activeInstanceCounts({
      desktop: [
        { loginUuid: 'live', account: { status: 'live' } },
        { loginUuid: 'unresolved', account: null },
        { loginUuid: 'cached', account: { status: 'cache' } },
        { loginUuid: 'offline', account: { status: 'offline' } },
        { loginUuid: null },
        { loginUuid: 'stale', appSignedOut: 'Signed out in app' },
        { loginUuid: 'rejected', account: { status: 'loggedout' } },
      ],
      codex: [{ loggedIn: true }, { loggedIn: false }],
      dsh: [{ running: true }, { running: false }],
      cli: [
        { loggedIn: true },
        { loggedIn: false },
        { loggedIn: true, movedAway: { at: 1, file: 'archive.json' } },
      ],
      free: [
        { loggedIn: true },
        { loggedIn: false },
        { loggedIn: true, poolState: 'pending' },
        { loggedIn: true, poolState: 'retired' },
        { loggedIn: true, movedAway: { at: 1 } },
      ],
    })).toEqual({ all: 8, desktop: 6, cli: 1, free: 1 })
  })

  it('keeps unknown network resolution distinct from an explicit sign-out', () => {
    expect(desktopSignedIn({ loginUuid: 'saved', account: { status: 'unknown' } })).toBe(true)
    expect(desktopSignedIn({ loginUuid: null, account: { status: 'live' } })).toBe(false)
  })

  it('supports disabled surfaces without altering the supplied account records', () => {
    const cli = [{ loggedIn: true }, { loggedIn: false }]
    const free = [{ loggedIn: true }, { loggedIn: true, poolState: 'retired' as const }]
    expect(activeInstanceCounts({ desktop: [], codex: [], dsh: [], cli, free }))
      .toEqual({ all: 2, desktop: 0, cli: 1, free: 1 })
    expect(cli).toHaveLength(2)
    expect(free).toHaveLength(2)
  })
})

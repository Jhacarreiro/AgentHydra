// server/tests/app-sign-in-log.test.ts - whether a running Claude Desktop app signed itself out,
// read from its own logs/main.log (core/app-sign-in-log.ts). The stored login outlives that
// sign-out, so before this the Instances list and every chooser read such an app as signed in.
import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appSignedOutFromLog, readAppSignedOut } from '../src/core/app-sign-in-log'

const ACTIVE = '2026-10-15 13:00:00 [info] claude.ai account active and logged in'
const LOGOUT = '2026-10-15 13:00:02 [info] [account] Navigated to /logout, synthesizing logged-out'
const LOGIN = '2026-10-15 13:05:00 [info] Login-state transition (loggedOut: true → false)'
// A chat's own error: the app authorizes again by itself and its chats run on.
const REVOKED = '2026-10-15 13:06:00 [error] api_error: OAuth token revoked'
const SKIP = '2026-10-15 13:07:00 [info] User is logged out, skipping account ID wait'

test.each([
  [
    'signed in, then its own /logout',
    [ACTIVE, LOGOUT],
    '[account] Navigated to /logout, synthesizing logged-out',
  ],
  ['a sign-in after the /logout', [ACTIVE, LOGOUT, LOGIN], null],
  ['a later start with its account loaded', [LOGOUT, ACTIVE], null],
  ["a chat's revoked-token error", [ACTIVE, REVOKED], null],
  ['a start that was already signed out says nothing new', [SKIP], null],
  ['no log', null, null],
] as const)('%s', (_case, lines, want) => {
  expect(appSignedOutFromLog(lines === null ? null : lines.join('\n'))).toBe(want)
})

const dir = mkdtempSync(join(tmpdir(), 'app-sign-in-log-'))
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test('reads the tail of <profile>/logs/main.log, and reads it again once the app writes more', () => {
  mkdirSync(join(dir, 'logs'))
  const log = join(dir, 'logs', 'main.log')
  writeFileSync(log, `${ACTIVE}\n${LOGOUT}\n`)
  expect(readAppSignedOut(dir)).toContain('Navigated to /logout')
  appendFileSync(log, `${LOGIN}\n`)
  expect(readAppSignedOut(dir)).toBeNull()
})

test('a profile with no log is not signed out (the stored login decides)', () => {
  expect(readAppSignedOut(join(dir, 'no-such-profile'))).toBeNull()
})

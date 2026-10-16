// The native stop runs inside Claude Desktop's main process; here the shipped expression runs against a stand-in of
// that process (its module cache holding a session manager), so what it would call in the app is what is checked.
import { expect, test } from 'bun:test'
import * as path from 'node:path'
import { nativeApp } from './native-app'

/** A desktop app whose one chat (`local_a`) has `session`; `onInterrupt` is the app's own interruptSession, so a test
 *  decides what the app's state shows after the call. */
function desktop(
  session: Record<string, unknown>,
  onInterrupt: (s: Record<string, any>) => void | Promise<void> = (s) => {
    s.isStopping = true
  },
) {
  const calls: { id: string; reason: string }[] = []
  const app = nativeApp(session, {
    interruptSession: async (id: string, reason: string) => {
      calls.push({ id, reason })
      await onInterrupt(app.chat)
    },
  })
  const stop = (request: { profileDir?: string; cliSessionId?: string } = {}) =>
    app.run({ action: 'stop', ...request })
  return { calls, chat: app.chat, stop }
}

test("a working chat is stopped through the app's own interruptSession, once, and verified by its state", async () => {
  const app = desktop({})
  const stopped = await app.stop()
  expect(stopped).toMatchObject({
    ok: true,
    verified: true,
    dispatch: 'sent',
    action: 'stop',
    sessionId: 'local_a',
  })
  expect(app.calls).toEqual([{ id: 'local_a', reason: 'user' }])
})

test('a chat whose turn is already stopping, or that has no running turn, is refused before the app is called', async () => {
  const idle = desktop({ isRunning: false })
  expect(await idle.stop()).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(idle.calls).toEqual([])

  const stopping = desktop({ isStopping: true })
  expect(await stopping.stop()).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(stopping.calls).toEqual([])

  const archived = desktop({ isArchived: true })
  expect(await archived.stop()).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(archived.calls).toEqual([])
})

test('a wrong profile or a session id no chat holds is refused, and nothing is called', async () => {
  const app = desktop({})
  expect(
    await app.stop({ profileDir: path.resolve('/Users/me/.claude-instances/other') }),
  ).toMatchObject({ ok: false, refused: true, dispatch: 'not-sent' })
  expect(await app.stop({ cliSessionId: '11111111-2222-4333-8444-555555555555' })).toMatchObject({
    ok: false,
    refused: true,
    dispatch: 'not-sent',
    reason: expect.stringContaining('no chat in this app holds this CLI session'),
  })
  expect(app.calls).toEqual([])
})

test('a stop the app does not show stopping or stopped is reported unverified, and is never sent again', async () => {
  // The app answers but its state does not change: not verified, and the one call is not retried.
  const unchanged = desktop({}, () => {})
  const quiet = await unchanged.stop()
  expect(quiet).toMatchObject({ ok: false, verified: false, dispatch: 'sent' })
  expect(unchanged.calls).toHaveLength(1)

  // The call throws after it was made: the dispatch is 'sent' (not unavailable), nothing else is tried.
  const thrown = desktop({}, () => {
    throw new Error('renderer went away')
  })
  expect(await thrown.stop()).toMatchObject({
    ok: false,
    dispatch: 'sent',
    reason: expect.stringContaining('renderer went away'),
  })
  expect(thrown.calls).toHaveLength(1)
})

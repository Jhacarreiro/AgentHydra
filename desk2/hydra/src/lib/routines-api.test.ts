// Regression (2026-10-12): Desk's Settings > Managers > Routines sent its actions unmarked, so the server, which lets only
// the window resume, approve, discard or switch the manager and knows the window by its caller mark, refused the owner's
// own Approve with 403. Since 2026-10-17 those actions live only here, in the Tools tab (owner: the Managers page "just
// literally takes you to the tools tab now"), so the guard moved with them: checked against the server's own callerKind.
import { afterEach, expect, test } from 'bun:test'
import type { RoutinesRequest } from '@desk/shared/routines'
import { callerKind } from '../../../server/src/caller'
import { postRoutines } from './routines-api'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test("the owner's routine actions from the Tools tab reach the server as the window's", async () => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) =>
    callerKind(new Headers(init?.headers)) === 'window'
      ? Response.json({ enabled: true, routines: [], proposals: [] })
      : Response.json({ error: 'only the owner can do that' }, { status: 403 })) as typeof fetch
  const owners: RoutinesRequest[] = [{ approve: 'p' }, { discard: 'p' }, { resume: 'r' }, { pause: 'r' }, { enabled: false }]
  for (const body of owners) await expect(postRoutines(body)).resolves.toMatchObject({ enabled: true })
})

// Move to account > Unassigned reads AgentHydra's desktop-archive answer (session-header/ah.ts unassignSession). The
// sidebar says "Unassigned" only on a verdict that the chat left its account; a refused or unverified archive must
// not read as done (the chat would sit in Unassigned while its account still runs it), and a terminal chat no desktop
// account holds has nothing to take off.

import { afterEach, expect, test } from 'bun:test'
import { unassignSession } from '@/components/session-header/ah'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function answer(status: number, body: unknown): { url: string; body: unknown }[] {
  const asked: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return asked
}

test('an archive its app confirmed, or one only a restart will show, is Unassigned; it names the account it was on', async () => {
  const asked = answer(200, { ok: true, verified: true })
  expect(await unassignSession('s-1', 'desktop:C:/p/72')).toEqual({ ok: true, stillShown: false })
  expect(asked[0]).toEqual({ url: '/ah/api/sessions/s-1/desktop-archive', body: { instance_ref: 'desktop:C:/p/72' } })
  answer(200, { ok: true, hits: [{ changed: true }], flagOnDisk: [{ isArchived: true }], flagStuck: true, stillOnScreen: true })
  expect(await unassignSession('s-1', null)).toEqual({ ok: true, stillShown: true })
})

test('a refusal, an unverified archive or a flag put back is not, with the reason AgentHydra gave', async () => {
  answer(409, { ok: false, error: 'session-live: refusing to archive a chat with a running engine' })
  expect(await unassignSession('s-1', null)).toEqual({ ok: false, error: 'session-live: refusing to archive a chat with a running engine' })
  answer(200, { ok: true, verified: false, reason: 'NATIVE_REFUSAL: busy' })
  expect(await unassignSession('s-1', null)).toEqual({ ok: false, error: 'NATIVE_REFUSAL: busy' })
  answer(200, { ok: true, hits: [{ changed: true }], flagOnDisk: [{ isArchived: false }], flagStuck: false })
  expect((await unassignSession('s-1', null)).ok).toBe(false)
})

test('a chat no desktop account holds has nothing to take off', async () => {
  answer(404, { ok: false, hits: [] })
  expect(await unassignSession('s-1', null)).toEqual({ ok: true, stillShown: false })
})

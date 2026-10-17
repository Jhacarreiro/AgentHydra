// server/tests/toolbox-calls.test.ts: a restart never cuts a chat move's call into the daemon.
//
// A move runs on through a restart (orchestrator.ts MOVE_SCRIPTS), but its steps are calls into the
// daemon, and an exit cuts whatever it is serving. A relaunch parks the move's calls first: a new one
// is turned away unrun (hydralib sends it again, to the next daemon), and one already inside a route
// is waited for.
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  OPERATION_HEADER,
  parkToolboxCalls,
  RESTARTING_HEADER,
  resumeToolboxCalls,
  toolboxCallGate,
} from '../src/toolbox-calls'

test('a parked daemon turns a move call away unrun and waits for the one already inside', async () => {
  const app = new Hono()
  app.use('*', toolboxCallGate())
  let ran = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  app.post('/slow', async (c) => {
    ran++
    await held
    return c.json({ ok: true })
  })
  app.post('/quick', (c) => {
    ran++
    return c.json({ ok: true })
  })
  const move = { [OPERATION_HEADER]: 'op-1' }

  const inside = app.request('/slow', { method: 'POST', headers: move })
  while (ran === 0) await Bun.sleep(1)
  const parked: { left: number | null } = { left: null }
  const park = parkToolboxCalls(10_000).then((n) => {
    parked.left = n
  })

  const turned = await app.request('/quick', { method: 'POST', headers: move })
  expect(turned.status).toBe(503)
  expect(turned.headers.get(RESTARTING_HEADER)).toBe('1')
  expect(ran).toBe(1)
  // Everyone else's calls (a chat's MCP, the window) are served as ever.
  expect((await app.request('/quick', { method: 'POST' })).status).toBe(200)
  await Bun.sleep(20)
  expect(parked.left).toBeNull()

  release()
  expect((await inside).status).toBe(200)
  await park
  expect(parked.left).toBe(0)

  // A handover that did not happen: the daemon takes the move's calls again.
  resumeToolboxCalls()
  expect((await app.request('/quick', { method: 'POST', headers: move })).status).toBe(200)
})

// Desk's /api/settings, read and written by the Tools tab's switches. The fetch is stubbed, and the real one is put back
// after the file (the preload's rule for a swapped global).
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { DeskSettings } from '@desk/shared/protocol'
import { useDeskSettings } from './useDeskSettings'

const realFetch = globalThis.fetch
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }
let calls: Call[] = []
let reply: (call: Call) => Response = () => new Response('{}', { status: 500 })

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    return reply(call)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const settings = (over: Partial<DeskSettings> = {}): DeskSettings =>
  ({
    babysitter: false,
    instanceManager: true,
    orchestrator: false,
    orchestratorModel: 'opus',
    ...over,
  }) as DeskSettings

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

it('reads the relative /api/settings and keeps what Desk answers', async () => {
  calls = []
  reply = () => json(settings({ babysitter: true }))
  const desk = useDeskSettings()
  await desk.refresh()
  expect(calls.map((c) => c.url)).toEqual(['/api/settings'])
  expect(desk.available).toBe(true)
  expect(desk.settings?.babysitter).toBe(true)
})

it('a 404 means no Desk: unavailable, nothing errors', async () => {
  calls = []
  reply = () => new Response('', { status: 404 })
  const desk = useDeskSettings()
  await desk.refresh()
  expect(desk.available).toBe(false)
  expect(desk.settings).toBeNull()
  expect(desk.error).toBeNull()
})

it('a PUT sends the patch as the window and takes the server echo', async () => {
  calls = []
  reply = () => json(settings({ orchestrator: true }))
  const desk = useDeskSettings()
  const refusal = await desk.save({ orchestrator: true })
  expect(refusal).toBeNull()
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ url: '/api/settings', method: 'PUT', body: { orchestrator: true } })
  expect(calls[0].headers['X-Desk-Caller']).toBe('window')
  expect(desk.settings?.orchestrator).toBe(true)
  expect(desk.error).toBeNull()
})

it('a refused PUT keeps the old value and sets the reason', async () => {
  const desk = useDeskSettings()
  reply = () => json(settings({ babysitter: false }))
  await desk.refresh()

  reply = () => json({ error: 'Desk is busy with a restart' }, 409)
  const refusal = await desk.save({ babysitter: true })
  expect(refusal).toBe('Desk is busy with a restart')
  expect(desk.settings?.babysitter).toBe(false)
  expect(desk.error).toBe('Desk is busy with a restart')
  expect(desk.saving).toBe(false)
})

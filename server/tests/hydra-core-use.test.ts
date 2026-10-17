import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { type Daemon, defaultDaemon, use } from '../src/hydra-core/use'
import type { UseModeAsk } from '../src/people-host'
import { scratch } from './hydra-core-fixture'
import { installUseAddon, removeUseAddon } from './people-fake-addon'

let dir = ''
const chat = 'chat-example-use'
const now = new Date('2019-10-22T10:00:00.000Z')

let savedPort: string | undefined
beforeEach(() => {
  dir = scratch()
  // No Desk: a consult here has no Desk chat to resolve, so it never reaches a real Desk.
  savedPort = process.env.HYDRA_DESK_PORT
  process.env.HYDRA_DESK_PORT = '9'
})
afterEach(() => {
  removeUseAddon()
  if (savedPort === undefined) delete process.env.HYDRA_DESK_PORT
  else process.env.HYDRA_DESK_PORT = savedPort
  rmSync(dir, { recursive: true, force: true })
})

const calls: string[] = []
const daemon: Daemon = {
  async dispatch() {
    calls.push('dispatch')
    return 'job-1'
  },
  async report() {
    calls.push('report')
    return null
  },
  async send() {
    calls.push('send')
  },
}

test('without the people add-on a persona mode answers that there are no people here, and starts nothing', async () => {
  calls.length = 0
  for (const mode of ['become', 'consult', 'hire'] as const)
    await expect(
      use(dir, { chat, id: 'person:iris-ui', mode, question: 'q', job: 'j' }, daemon, now),
    ).rejects.toThrow('no people on this PC')
  expect(calls).toEqual([])
})

test('an add-on that does not answer a persona mode is the same as no add-on', async () => {
  await installUseAddon()
  await expect(
    use(dir, { chat, id: 'person:iris-ui', mode: 'become' }, daemon, now),
  ).rejects.toThrow('no people on this PC')
})

test('a persona mode is handed to the add-on with the entry, the args, the daemon and the time; its answer comes back as is', async () => {
  await installUseAddon()
  const asked: UseModeAsk[] = []
  globalThis.__useModeMock = (ask) => {
    asked.push(ask)
    return { fromAddon: true }
  }
  const r = await use(dir, { chat, id: 'person:iris-ui', mode: 'become' }, daemon, now)
  expect(r).toEqual({ fromAddon: true })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({
    dir,
    mode: 'become',
    entry: { id: 'person:iris-ui', name: 'Iris Example' },
    args: { chat, id: 'person:iris-ui', mode: 'become' },
    chat: null,
    now,
  })
  expect(asked[0]?.daemon).toBe(daemon)
})

test('become refuses an entry that is not a person, before the add-on is asked', async () => {
  await installUseAddon()
  let asked = 0
  globalThis.__useModeMock = () => ++asked
  await expect(
    use(dir, { chat, id: 'instrument:screen-capture', mode: 'become' }, daemon, now),
  ).rejects.toThrow('is not a person')
  expect(asked).toBe(0)
})

test('a person refuses a mode it does not allow', async () => {
  await expect(
    use(dir, { chat, id: 'person:ops-lead', mode: 'consult', question: 'q' }, daemon, now),
  ).rejects.toThrow('does not allow mode consult')
})

test('load returns the text of a non-person entry and refuses a person', async () => {
  expect(
    await use(dir, { chat, id: 'instrument:screen-capture', mode: 'load' }, daemon, now),
  ).toEqual({
    id: 'instrument:screen-capture',
    text: 'Run: capture --url <url>',
  })
  await expect(use(dir, { chat, id: 'person:iris-ui', mode: 'load' }, daemon, now)).rejects.toThrow(
    'use become, consult or hire',
  )
})

test('the daemon client reads the report view, which the daemon answers as a bare list', async () => {
  const seen: string[] = []
  const api = async (path: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${path}`)
    if (init?.method === 'POST') return { workers: [{ id: 'w-1' }] }
    return [{ id: 'w-1', status: 'done', report: 'Grid is fine.' }]
  }
  const client = defaultDaemon(api)
  expect(await client.dispatch('p', 't', 'C:/Users/me/example-folder')).toBe('w-1')
  expect(await client.report('w-1', 30)).toEqual({ status: 'done', text: 'Grid is fine.' })
  expect(seen[1]).toContain('ids=w-1')
})

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { FreeThread } from '../../shared/free-instances'
import type { ServerContext } from '../src/context'
import { FreeInstances } from '../src/free-instances/service'
import type { FreeRuntime } from '../src/free-instances/runtime'
import type { FreeStorage } from '../src/free-instances/storage'
import plugin from '../src/plugins/55-free-instances'

const fixtures: Array<{ home: string; service: FreeInstances }> = []
afterEach(async () => {
  for (const { home, service } of fixtures.splice(0)) {
    await service.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'free-history-selector-'))
  const runtime: FreeRuntime = {
    ready: () => true,
    ensure: async () => { throw new Error('A history selector must not start a provider') },
    config: id => ({ harnessDir: home, python: join(home, 'python.exe'),
      stateDir: join(home, 'free', 'instances', id), cacheDir: join(home, 'cache') }),
  }
  const service = new FreeInstances(home, async () => { throw new Error('No provider calls') }, runtime)
  fixtures.push({ home, service })
  const first = service.create({ provider: 'claude', name: 'Example first account' })
  const second = service.create({ provider: 'chatgpt', name: 'Example second account' })
  const store = (service as unknown as { store: FreeStorage }).store
  const app = new Hono()
  plugin(app, { home, deps: { freeInstances: service }, onStop: () => {} } as unknown as ServerContext)
  return { service, first, second, store, app }
}

function thread(instanceId: string, chatId: string, updatedAt: number): FreeThread {
  return { id: `${instanceId}/${chatId}`, instanceId, provider: 'claude', chatId,
    title: 'Synthetic thread', status: 'done', createdAt: 1, updatedAt, error: null }
}

test('recent selection sends only 30 of 36000 rows, preserves stable order and never mutates history', async () => {
  const { app, first, store, service } = fixture()
  const history = Array.from({ length: 36_000 }, (_, index) => thread(first.id, `synthetic-${index}`, Math.floor(index / 2)))
  store.data.threads = history
  const expected = [...history].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30)
  service.threads = () => { throw new Error('No raw history serialization for a selection') }
  const response = await app.request('/api/free/threads?view=recent')
  expect(response.status).toBe(200)
  expect(response.headers.get('ETag')).toBeNull()
  const text = await response.text()
  expect(text.length).toBeLessThan(20_000)
  expect(JSON.parse(text)).toEqual({ total: 36_000, threads: expected })
  expect(store.data.threads).toBe(history)
  expect(store.data.threads[0]!.chatId).toBe('synthetic-0')
})

test('recent selection retains account, unusual limit and legacy timestamp ordering semantics', () => {
  const { service, first, second, store } = fixture()
  store.data.threads = [thread(first.id, 'first', 3), thread('removed-account', 'orphan', 9),
    thread(second.id, 'second', 3), thread(first.id, 'unknown-time', Number.NaN), thread(first.id, 'last', 8)]
  const source = store.data.threads
  for (const account of [undefined, first.num, second.num, 999, Number.NaN]) {
    const matching = source.filter(t => account === undefined ||
      service.allInstances().find(i => i.id === t.instanceId)?.num === account)
    for (const limit of [0, Number.NaN, -1, 1, 2.5, Infinity, 500]) {
      const count = Math.max(1, Math.min(Number(limit) || 30, 500))
      expect(service.recentThreads(limit, account)).toEqual({ total: matching.length,
        threads: [...matching].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, count) })
    }
  }
  expect(service.recentThreads(500).threads.some(t => t.chatId === 'orphan')).toBe(true)
})

test('lookup returns the first stored duplicate even when its account is gone, with bounded identifiers', async () => {
  const { app, first, second, store } = fixture()
  const original = thread('removed-account', 'duplicate', 1)
  const later = thread(first.id, 'duplicate', 999)
  const other = thread(second.id, 'other', 2)
  store.data.threads = [original, later, other]
  const tag = (await app.request('/api/free/threads')).headers.get('ETag')!
  const lookup = await app.request('/api/free/threads?view=lookup&chat_id=duplicate&chat_id=other&chat_id=duplicate',
    { headers: { 'If-None-Match': tag } })
  expect(lookup.status).toBe(200)
  expect(lookup.headers.get('ETag')).toBeNull()
  expect(await lookup.json()).toEqual([original, other])
  expect(await (await app.request('/api/free/threads?view=lookup&chat_id=unknown')).json()).toEqual([])
  const ids = new URLSearchParams({ view: 'lookup' })
  for (let index = 0; index < 33; index++) ids.append('chat_id', String(index))
  expect((await app.request(`/api/free/threads?${ids}`)).status).toBe(400)
})

test('selectors preserve raw conditional and since reads and remain behind the origin guard', async () => {
  const { app, first, store } = fixture()
  store.data.threads = [thread(first.id, 'one', 2), { ...thread(first.id, 'two', 3), createdAt: 4 }]
  const raw = await app.request('/api/free/threads')
  expect(raw.status).toBe(200)
  expect(await raw.json()).toEqual(store.data.threads)
  const tag = raw.headers.get('ETag')!
  expect((await app.request('/api/free/threads', { headers: { 'If-None-Match': tag } })).status).toBe(304)
  const selected = await app.request('/api/free/threads?view=recent&limit=1', { headers: { 'If-None-Match': tag } })
  expect(selected.status).toBe(200)
  expect(await selected.json()).toEqual({ total: 2, threads: [store.data.threads[1]] })
  const since = await app.request('/api/free/threads?since=4', { headers: { 'If-None-Match': tag } })
  expect(since.status).toBe(200)
  expect(since.headers.get('ETag')).toBeNull()
  expect(await since.json()).toEqual([store.data.threads[1]])
  for (const view of ['recent', 'lookup']) {
    const rejected = await app.request(`/api/free/threads?view=${view}`, { headers: { origin: 'https://example.test' } })
    expect(rejected.status).toBe(403)
  }
})

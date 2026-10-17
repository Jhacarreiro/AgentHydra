// server/tests/login-sync-chats-store.test.ts — the chat and chunk routes of the real login sync Worker.

import { expect, test } from 'bun:test'
import { base, cron, env, forgetPcs, store, storeDb, token } from './login-sync-store'

const newId = () => crypto.randomUUID()
const chunk = (id: string, seq: number, blob: string, by = 'pc-a') =>
  store('PUT', `/v1/chats/${id}/chunks/${seq}`, { blob, by })

test('a chat row is written by compare-and-swap and listed without its blob', async () => {
  const id = newId()
  expect(
    (await store('PUT', `/v1/chats/${id}`, { version: 0, blob: 'one', meta: { t: 1 } })).json,
  ).toEqual({
    version: 1,
  })
  const stale = await store('PUT', `/v1/chats/${id}`, { version: 0, blob: 'two', meta: {} })
  expect(stale.status).toBe(409)
  expect(stale.json.current.version).toBe(1)
  expect(
    (await store('PUT', `/v1/chats/${id}`, { version: 1, blob: 'two', meta: {} })).json,
  ).toEqual({
    version: 2,
  })
  const listed = (await store('GET', '/v1/chats')).json.chats.find(
    (c: { id: string }) => c.id === id,
  )
  expect(listed.version).toBe(2)
  expect(listed.blob).toBeUndefined()
  expect((await store('GET', `/v1/chats/${id}`)).json.blob).toBe('two')
  expect((await store('GET', `/v1/chats/${newId()}`)).status).toBe(404)
})

test('a chunk seq is written once, lists in order from `from`, and a page stops past the budget', async () => {
  const id = newId()
  expect((await chunk(id, 1, 'b')).json).toEqual({ seq: 1 })
  expect((await chunk(id, 0, 'a')).json).toEqual({ seq: 0 })
  const taken = await chunk(id, 1, 'changed')
  expect(taken.status).toBe(409)
  expect(taken.json).toEqual({ error: 'taken', next: 2 })
  const all = (await store('GET', `/v1/chats/${id}/chunks`)).json
  expect(
    all.chunks.map((c: { seq: number; blob: string; by: string }) => [c.seq, c.blob, c.by]),
  ).toEqual([
    [0, 'a', 'pc-a'],
    [1, 'b', 'pc-a'],
  ])
  expect(all).toMatchObject({ next: 2, more: false })
  const tail = (await store('GET', `/v1/chats/${id}/chunks?from=1`)).json
  expect(tail.chunks.map((c: { seq: number }) => c.seq)).toEqual([1])
  expect((await store('GET', `/v1/chats/${id}/chunks?from=5`)).json).toEqual({
    chunks: [],
    next: 5,
    more: false,
  })

  const big = newId()
  const blob = 'x'.repeat(1_048_576)
  for (let seq = 0; seq < 9; seq++) expect((await chunk(big, seq, blob)).status).toBe(200)
  const page = (await store('GET', `/v1/chats/${big}/chunks`)).json
  expect(page.chunks).toHaveLength(8)
  expect(page).toMatchObject({ next: 8, more: true })
  const rest = (await store('GET', `/v1/chats/${big}/chunks?from=${page.next}`)).json
  expect(rest.chunks.map((c: { seq: number }) => c.seq)).toEqual([8])
  expect(rest.more).toBe(false)
})

test('caps: an oversize blob and a bad id are 400, a missing token is 401', async () => {
  const id = newId()
  expect((await chunk(id, 0, 'x'.repeat(1_048_577))).status).toBe(400)
  expect((await chunk(id, 0, '')).status).toBe(400)
  expect((await chunk(id, 1_000_001, 'a')).status).toBe(400)
  expect((await chunk('not-a-uuid', 0, 'a')).status).toBe(400)
  expect(
    (await store('PUT', '/v1/chats/not-a-uuid', { version: 0, blob: 'a', meta: {} })).status,
  ).toBe(400)
  expect((await fetch(`${base}/v1/chats`)).status).toBe(401)
})

test('deleting a chat at its current version removes its session’s chunks once no other row shares them', async () => {
  // The transcript lives under the session (meta.s), and two rows can share one session.
  const id = newId()
  const other = newId()
  const session = newId()
  await store('PUT', `/v1/chats/${id}`, { version: 0, blob: 'one', meta: { s: session } })
  await store('PUT', `/v1/chats/${other}`, { version: 0, blob: 'two', meta: { s: session } })
  await chunk(session, 0, 'a')
  expect((await store('DELETE', `/v1/chats/${id}?version=9`)).status).toBe(409)
  expect((await store('GET', `/v1/chats/${id}`)).status).toBe(200)
  expect((await store('DELETE', `/v1/chats/${id}?version=1`)).json).toEqual({ ok: true })
  expect((await store('GET', `/v1/chats/${id}`)).status).toBe(404)
  expect((await store('GET', `/v1/chats/${session}/chunks`)).json.chunks).toHaveLength(1)
  expect((await store('DELETE', `/v1/chats/${other}?version=1`)).json).toEqual({ ok: true })
  expect((await store('GET', `/v1/chats/${session}/chunks`)).json.chunks).toEqual([])
})

test('a chunk that would take chats past their room is refused with 507, and a delete gives the room back', async () => {
  const id = newId()
  const session = newId()
  await store('PUT', `/v1/chats/${id}`, { version: 0, blob: 'r', meta: { s: session } })
  try {
    env.CHAT_STORE_MB = '0.000001'
    const full = await chunk(session, 0, 'a')
    expect(full.status).toBe(507)
    expect((await store('GET', `/v1/chats/${session}/chunks`)).json.chunks).toEqual([])
    // Room for exactly ten more characters than every chunk already stored.
    env.CHAT_STORE_MB = String((full.json.used + 10.5) / 1048576)
    expect((await chunk(session, 0, 'x'.repeat(10))).status).toBe(200)
    expect((await chunk(session, 1, 'y')).status).toBe(507)
    await store('DELETE', `/v1/chats/${id}?version=1`)
    expect((await chunk(newId(), 0, 'z'.repeat(10))).status).toBe(200)
  } finally {
    delete env.CHAT_STORE_MB
  }
})

test('the daily cron frees a day-old session’s chunks that no row names and gives their room back', async () => {
  // A sender that moved a chat to another session left the old one's chunks under no row.
  const orphan = newId()
  const young = newId()
  const named = newId()
  await store('PUT', `/v1/chats/${newId()}`, { version: 0, blob: 'r', meta: { s: named } })
  await chunk(orphan, 0, 'o'.repeat(60))
  await chunk(orphan, 1, 'o'.repeat(40))
  await chunk(young, 0, 'y')
  await chunk(named, 0, 'n')
  const dayAgo = Date.now() - 25 * 3600_000
  for (const s of [orphan, named])
    await storeDb
      .prepare('UPDATE chat_chunks SET created_at = ? WHERE chat = ?')
      .bind(dayAgo, s)
      .run()
  try {
    env.CHAT_STORE_MB = '0.000001'
    const used = (await chunk(newId(), 0, 'a')).json.used
    // Room for 50 more characters than every chunk stored: full for the next 100.
    env.CHAT_STORE_MB = String((used + 50.5) / 1048576)
    expect((await chunk(newId(), 0, 'z'.repeat(100))).status).toBe(507)
    await cron()
    expect((await chunk(newId(), 0, 'z'.repeat(100))).status).toBe(200)
  } finally {
    delete env.CHAT_STORE_MB
  }
  expect((await store('GET', `/v1/chats/${orphan}/chunks`)).json.chunks).toEqual([])
  expect((await store('GET', `/v1/chats/${young}/chunks`)).json.chunks).toHaveLength(1)
  expect((await store('GET', `/v1/chats/${named}/chunks`)).json.chunks).toHaveLength(1)
})

// The relay: a chat row naming its session, the PC it started on and its stream (no `k: 'r'`, so a chat
// sync PC in another test file never takes it for a record).
const relayChat = async (writer: string, stream: string) => {
  const id = newId()
  const session = newId()
  await store('PUT', `/v1/chats/${id}`, {
    version: 0,
    blob: 'r',
    meta: { s: session, pc: writer, o: stream },
  })
  return { id, session }
}
const ack = (id: string, pc: string, next: number, o: string) =>
  store('POST', `/v1/chats/${id}/ack`, { pc, next, o })
const poll = (pc: string) =>
  fetch(`${base}/v1/changes?since=0`, {
    headers: { authorization: `Bearer ${token}`, 'x-agenthydra-pc': pc },
  }).then((r) => r.text())

test('a reader’s ack frees the chunks every reader holds and their room; below that floor a read is 410 and a write is taken', async () => {
  forgetPcs()
  const writer = newId()
  const reader = newId()
  const { id, session } = await relayChat(writer, 'o1')
  for (const [seq, blob] of ['aaaa', 'bbbb', 'cccc'].entries())
    expect((await chunk(session, seq, blob, writer)).status).toBe(200)
  try {
    env.CHAT_STORE_MB = '0.000001'
    const used = (await chunk(newId(), 0, 'a')).json.used
    env.CHAT_STORE_MB = String((used + 5.5) / 1048576)
    expect((await chunk(newId(), 0, 'z'.repeat(8))).status).toBe(507)

    expect((await ack(id, reader, 2, 'o1')).json).toEqual({ ok: true, floor: 2 })
    expect((await chunk(newId(), 0, 'z'.repeat(8))).status).toBe(200)
  } finally {
    delete env.CHAT_STORE_MB
  }
  const rest = (await store('GET', `/v1/chats/${session}/chunks?from=2`)).json
  expect(rest.chunks.map((c: { seq: number }) => c.seq)).toEqual([2])
  const gone = await store('GET', `/v1/chats/${session}/chunks?from=0`)
  expect(gone).toEqual({ status: 410, json: { error: 'gone', floor: 2 } })
  expect(await chunk(session, 0, 'aaaa', writer)).toEqual({
    status: 409,
    json: { error: 'taken', next: 3 },
  })
  expect((await chunk(session, 3, 'dddd', writer)).status).toBe(200)
})

test('a chat’s readers: a PC seen that never acks holds the chunks, the PC it started on is none, and an ack of another stream frees nothing', async () => {
  forgetPcs()
  const writer = newId()
  const acking = newId()
  const older = newId() // polls the store but has no relay: an older build, or chats off
  await poll(writer)
  await poll(older)
  const { id, session } = await relayChat(writer, 'o1')
  await chunk(session, 0, 'aaaa', writer)
  const held = async () => (await store('GET', `/v1/chats/${session}/chunks`)).json.chunks?.length

  expect((await ack(id, acking, 1, 'o1')).json).toEqual({ ok: true, floor: 0 })
  expect(await held()).toBe(1)
  expect(await ack(id, older, 1, 'o2')).toEqual({ status: 409, json: { error: 'stream changed' } })
  expect(await held()).toBe(1)
  expect((await ack(id, older, 1, 'o1')).json).toEqual({ ok: true, floor: 1 })
  expect((await store('GET', `/v1/chats/${session}/chunks`)).status).toBe(410)
})

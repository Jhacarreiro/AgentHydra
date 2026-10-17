import { afterAll, afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteSend,
  recoverDeliveryReceipts,
  requeueUnread,
  settleStoppedDeliveries,
} from '../src/climayte'
import { listeners, workers } from '../src/climayte-core'
import { hasDeliveryPosts } from '../src/climayte-delivery-echo'
import type { CliMayteAttempt, CliMayteWorker } from '../src/climayte-lib'
import { forgetRead, readLog, refreshLog } from '../src/climayte-stops'

const root = mkdtempSync(join(tmpdir(), 'ah-delivery-echo-'))
const made: CliMayteWorker[] = []
let serial = 0
afterEach(() => {
  for (const w of made.splice(0)) {
    workers.delete(w.id)
    for (const at of w.attempts) forgetRead(at.log)
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { content: [{ type: 'text', text }] },
  ...extra,
})
const chatter = () =>
  Array.from({ length: 450 }, () => ({ type: 'assistant', message: { content: [] } }))
const stream = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n'
const receipt = (text: string, accepted = true) => ({
  requestId: `receipt-${++serial}`,
  text,
  accepted,
})

function fixture(deliveries: NonNullable<CliMayteAttempt['deliveries']> = []) {
  const id = `w-echo-${++serial}`
  const at = {
    account: { id: 'synthetic-account', num: 1, name: 'Synthetic', configDir: root },
    log: join(root, `${id}.jsonl`),
    errLog: join(root, `${id}.err.log`),
    pid: process.pid,
    daemonPid: process.pid,
    startedAt: Date.now(),
    endedAt: null,
    outcome: 'running',
    notice: null,
    resumed: false,
    deliver: {
      token: 'synthetic-token',
      portFile: join(root, `${id}.port`),
      delivered: join(root, `${id}.delivered`),
    },
    deliveries,
  } as CliMayteAttempt
  const w = {
    id,
    group: 'synthetic-echo',
    title: 'Synthetic echo task',
    prompt: 'prompt',
    cwd: root,
    status: 'running',
    pending: [],
    sendIds: [],
    attempts: [at],
    model: null,
    effort: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    costUsd: 0,
    turns: 0,
    retries: 0,
    chat: false,
    sealed: false,
    lastActivity: null,
  } as unknown as CliMayteWorker
  workers.set(id, w)
  made.push(w)
  return { w, at, write: (events: unknown[]) => writeFileSync(at.log, stream(events)) }
}
function end(w: CliMayteWorker, at: CliMayteAttempt) {
  at.endedAt = Date.now()
  at.outcome = 'done'
  w.status = 'done'
}
async function until(predicate: () => boolean) {
  const limit = Date.now() + 2_000
  while (!predicate() && Date.now() < limit) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}
function runner(at: CliMayteAttempt) {
  const waiting = new Map<string, (response: Response) => void>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { requestId: string }
      return new Promise<Response>((resolve) => waiting.set(body.requestId, resolve))
    },
  })
  writeFileSync(at.deliver!.portFile, String(server.port))
  return {
    wait: (id: string) => until(() => waiting.has(id)),
    release: (id: string, status = 200) => waiting.get(id)?.(new Response('', { status })),
    stop() {
      for (const resolve of waiting.values()) resolve(new Response('', { status: 500 }))
      server.stop(true)
    },
  }
}

test('production log observer retains read receipts after both prompt and echo leave the 400-event tail', () => {
  const f = fixture([receipt('read'), receipt('unread')])
  f.write([user('prompt'), user('read'), ...chatter()])
  let notifications = 0
  const listener = () => {
    notifications++
  }
  listeners.add(listener)
  try {
    const r = readLog(f.at)
    expect(r.events).toHaveLength(400)
    expect(r.events.every((event) => (event as { type: string }).type === 'assistant')).toBe(true)
    expect(f.at.deliveries?.[0]?.read).toBe(true)
    expect(notifications).toBe(0)
  } finally {
    listeners.delete(listener)
  }
  end(f.w, f.at)
  expect(requeueUnread(f.w, f.at)).toBe(1)
  expect(f.w.pending).toEqual(['unread'])
  expect(requeueUnread(f.w, f.at)).toBe(0)
})

test('first user in a retained tail is a delivery, while hooks, tools and subagents are not echoes', () => {
  const f = fixture([receipt('A'), receipt('B')])
  f.write([
    user('Stop hook feedback: synthetic'),
    user('ignored', { isMeta: true }),
    user('ignored', { parent_tool_use_id: 'synthetic-subagent' }),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
    user('prompt'),
    ...chatter(),
    user('B'),
    user('A'),
  ])
  const r = readLog(f.at)
  expect(r.events.filter((event) => (event as { type: string }).type === 'user')).toHaveLength(2)
  end(f.w, f.at)
  expect(requeueUnread(f.w, f.at)).toBe(0)
  expect(f.w.pending).toEqual([])
})

test('restart replay consumes persisted read flags without confirming an unread identical message', () => {
  const f = fixture([receipt('same'), receipt('same'), receipt('other')])
  f.write([user('prompt'), user('same'), ...chatter()])
  readLog(f.at)
  const restored = JSON.parse(JSON.stringify(f.at)) as CliMayteAttempt
  forgetRead(f.at.log)
  f.w.attempts = [restored]
  readLog(restored)
  end(f.w, restored)
  expect(requeueUnread(f.w, restored)).toBe(2)
  expect(f.w.pending).toEqual(['same', 'other'])
})

test('sync and async reads overlapping feed each repeated message occurrence once', async () => {
  const f = fixture([receipt('same'), receipt('same')])
  f.write([user('prompt'), user('same')])
  const pending = refreshLog(f.at)
  readLog(f.at)
  await pending
  expect(f.at.deliveries?.map((entry) => entry.read === true)).toEqual([true, false])
  appendFileSync(f.at.log, stream([user('same')]))
  await refreshLog(f.at)
  expect(f.at.deliveries?.map((entry) => entry.read === true)).toEqual([true, true])
})

test('an echo before ACK and an ACK after finish do not replay the already-read message', async () => {
  const f = fixture()
  const server = runner(f.at)
  try {
    expect(climayteSend(f.w.id, 'read', { requestId: 'early-echo' }).delivered).toBe('in-turn')
    await server.wait('early-echo')
    f.write([user('prompt'), user('read'), ...chatter()])
    readLog(f.at)
    expect(f.at.deliveries?.[0]).toMatchObject({ accepted: false, read: true })
    end(f.w, f.at)
    expect(requeueUnread(f.w, f.at)).toBe(0)
    expect(f.at.deliveries).toHaveLength(1)
    server.release('early-echo')
    await until(() => !f.at.deliveries?.length)
    expect(f.w.pending).toEqual([])
    expect(f.w.status).toBe('done')
  } finally {
    server.stop()
  }
})

test('identical texts and an earlier refusal reconcile by exact text/count after all callbacks', async () => {
  const f = fixture()
  const server = runner(f.at)
  try {
    climayteSend(f.w.id, 'same', { requestId: 'refused' })
    climayteSend(f.w.id, 'same', { requestId: 'accepted' })
    await Promise.all([server.wait('refused'), server.wait('accepted')])
    f.write([user('prompt'), user('same')])
    readLog(f.at)
    server.release('refused', 409)
    server.release('accepted')
    await until(() => !hasDeliveryPosts(f.at))
    expect(f.w.pending).toEqual([])
    expect(f.at.deliveries).toHaveLength(2)
    end(f.w, f.at)
    expect(requeueUnread(f.w, f.at)).toBe(1)
    expect(f.w.pending).toEqual(['same'])
  } finally {
    server.stop()
  }
})

test('an uncertain HTTP response can echo later while the same CLI still runs', async () => {
  const f = fixture()
  const server = runner(f.at)
  try {
    climayteSend(f.w.id, 'late echo', { requestId: 'uncertain' })
    await server.wait('uncertain')
    f.write([user('prompt')])
    readLog(f.at)
    server.release('uncertain', 500)
    await until(() => !hasDeliveryPosts(f.at))
    expect(f.w.pending).toEqual([])
    appendFileSync(f.at.log, stream([user('late echo')]))
    readLog(f.at)
    end(f.w, f.at)
    expect(requeueUnread(f.w, f.at)).toBe(0)
    expect(f.w.pending).toEqual([])
  } finally {
    server.stop()
  }
})

test('only the last callback after finish queues unread messages and revives the same done attempt', async () => {
  const f = fixture()
  const server = runner(f.at)
  const removeBeforeDispatch = (w: CliMayteWorker) => {
    if (w === f.w && w.status === 'queued') workers.delete(w.id)
  }
  listeners.add(removeBeforeDispatch)
  try {
    climayteSend(f.w.id, 'one', { requestId: 'one' })
    climayteSend(f.w.id, 'two', { requestId: 'two' })
    await Promise.all([server.wait('one'), server.wait('two')])
    f.write([user('prompt')])
    readLog(f.at)
    end(f.w, f.at)
    expect(requeueUnread(f.w, f.at)).toBe(0)
    server.release('one')
    await until(() => f.at.deliveries?.[0]?.accepted === true)
    expect(f.w.pending).toEqual([])
    server.release('two', 409)
    await until(() => f.w.status === 'queued')
    expect(f.w.pending).toEqual(['one', 'two'])
    expect(f.at.deliveries).toEqual([])
  } finally {
    listeners.delete(removeBeforeDispatch)
    server.stop()
  }
})

test('stopped delivery recovery waits for confirmed exit and captures final echoes without revival', () => {
  const f = fixture([receipt('read'), receipt('unread')])
  f.write([user('prompt')])
  readLog(f.at)
  end(f.w, f.at)
  f.at.outcome = 'cancelled'
  f.w.status = 'cancelled'
  expect(settleStoppedDeliveries(f.w, f.at)).toBe(0) // synthetic pid is this still-live test process
  expect(f.at.deliveries).toHaveLength(2)
  appendFileSync(f.at.log, stream([user('read')]))
  f.at.pid = null
  forgetRead(f.at.log)
  expect(settleStoppedDeliveries(f.w, f.at)).toBe(1)
  expect(f.w.pending).toEqual(['unread'])
  expect(f.w.status).toBe('cancelled')
  expect(settleStoppedDeliveries(f.w, f.at)).toBe(0)
})

test('boot recovery retains missing and partial logs, but reconciles a verified full or empty log once', () => {
  const missing = fixture([receipt('missing', false)])
  const partial = fixture([receipt('partial', false)])
  const complete = fixture([receipt('read', false), receipt('unread', false)])
  const empty = fixture([receipt('empty', false)])
  for (const f of [missing, partial, complete, empty]) end(f.w, f.at)
  writeFileSync(
    partial.at.log,
    stream([user('prompt')]) + JSON.stringify(user('partial')).slice(0, -1),
  )
  complete.write([user('prompt'), user('read'), ...chatter()])
  writeFileSync(empty.at.log, '')
  expect(recoverDeliveryReceipts()).toBe(2)
  expect(missing.at.deliveries).toHaveLength(1)
  expect(partial.at.deliveries).toHaveLength(1)
  expect(missing.w.pending).toEqual([])
  expect(partial.w.pending).toEqual([])
  expect(complete.w.pending).toEqual(['unread'])
  expect(empty.w.pending).toEqual(['empty'])
  expect(recoverDeliveryReceipts()).toBe(0)
})

import { afterAll, describe, expect, test } from 'bun:test'
import type { ChatSummary, DeskSettings, QueueItem, QueueState, ServerEvent, TranscriptItem } from '@shared/protocol'
import { saveGlobals } from '../save-globals'

type UserItem = Extract<TranscriptItem, { kind: 'user' }>

// The window's half of the send queue: the store takes the server's queue from hello and queue.update
// (an older rev is dropped) and turns each action into its request. The store runs on a fake socket and
// fetch; each test says what the server answers.
function item(id: string, chatId = 'A'): QueueItem {
  return { id, rev: 1, createdAt: 0, updatedAt: 0, state: 'waiting', reason: null, text: `text ${id}`, kind: 'message', chatId }
}
function queue(rev: number, items: QueueItem[] = [], over: Partial<QueueState> = {}): QueueState {
  return { items, paused: false, sendMode: 'immediate', maxNewChats: 2, held: {}, rev, ...over }
}

let socket: { onmessage: ((e: { data: string }) => void) | null } | null = null
const restoreGlobals = saveGlobals('document', 'window', 'location', 'Notification', 'WebSocket', 'fetch')
const g = globalThis as Record<string, unknown>
g.document ??= { title: 'Hydra Desk', hidden: false, createElement: () => ({}) } // vue's runtime-dom makes a template element on load
g.window ??= { location: { protocol: 'http:', host: 'localhost:7801' }, addEventListener() {}, dispatchEvent() {}, focus() {} }
g.location ??= { protocol: 'http:', host: 'localhost:7801' }
g.Notification ??= { permission: 'denied', requestPermission() {} }
g.WebSocket = class {
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  constructor() {
    socket = this
  }
  close() {}
}

type Call = { path: string; method: string; body: unknown }
let calls: Call[] = []
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }
let hold: Promise<Response> | null = null // while set, every request waits on it
g.fetch = async (path: string, init?: RequestInit) => {
  calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
  if (hold) return hold
  return new Response(JSON.stringify(answer.body), { status: answer.status })
}
const { useDesk } = await import('../../src/stores/desk')
const desk = useDesk()
desk.disconnect()
await desk.init()
// What init() started stops, and the real globals come back, before the next file runs.
afterAll(() => {
  desk.disconnect()
  restoreGlobals()
})
const push = (e: ServerEvent) => socket?.onmessage?.({ data: JSON.stringify(e) })
const hello = (q?: QueueState) => push({ type: 'hello', version: 't', chats: [], settings: {} as DeskSettings, ...(q ? { queue: q } : {}) })
function server(body: unknown, status = 200) {
  calls = []
  answer = { status, body }
}

describe('the queue the window shows', () => {
  test('hello carries it whole, whatever its rev; a server without a queue sends none', () => {
    hello(queue(9, [item('a1')]))
    expect(desk.queue.value?.items.map((i) => i.id)).toEqual(['a1'])
    hello(queue(2)) // a restarted server may count afresh
    expect(desk.queue.value?.rev).toBe(2)
    hello()
    expect(desk.queue.value).toBeNull()
  })

  test('queue.update replaces it; an older one is dropped', () => {
    hello(queue(5))
    push({ type: 'queue.update', queue: queue(6, [item('a1'), item('a2')]) })
    expect(desk.queue.value?.items.map((i) => i.id)).toEqual(['a1', 'a2'])
    push({ type: 'queue.update', queue: queue(4, []) })
    expect(desk.queue.value?.rev).toBe(6)
    expect(desk.queue.value?.items).toHaveLength(2)
  })
})

describe('each queue action is one request', () => {
  test('add, edit, remove, send now and retry go to their routes', async () => {
    server(item('a1'))
    await desk.queueAdd({ kind: 'message', chatId: 'A', text: 'next' })
    await desk.queueEdit('a/1', { text: 'changed', ifRev: 3 })
    await desk.queueRemove('a1')
    await desk.queueSendNow('a1')
    await desk.queueRetry('a1')
    expect(calls).toEqual([
      { path: '/api/queue', method: 'POST', body: { kind: 'message', chatId: 'A', text: 'next' } },
      { path: '/api/queue/a%2F1', method: 'PATCH', body: { text: 'changed', ifRev: 3 } },
      { path: '/api/queue/a1', method: 'DELETE', body: undefined },
      { path: '/api/queue/a1/send-now', method: 'POST', body: undefined },
      { path: '/api/queue/a1/retry', method: 'POST', body: undefined }
    ])
  })

  test('a new chat is queued with its settings', async () => {
    server({ ...item('n1'), kind: 'chat', cwd: 'C:/work', startedChatId: null })
    await desk.queueAdd({ kind: 'chat', cwd: 'C:/work', prompt: 'start it', accountId: 'auto' })
    expect(calls[0]).toEqual({ path: '/api/queue', method: 'POST', body: { kind: 'chat', cwd: 'C:/work', prompt: 'start it', accountId: 'auto' } })
  })

  test('a move sends the whole new order with the rev it was made from, and takes the answer', async () => {
    hello(queue(7, [item('a1'), item('b1', 'B'), item('a2')]))
    server(queue(8, [item('a2'), item('b1', 'B'), item('a1')]))
    await desk.queueMove('a2', -1)
    expect(calls).toEqual([{ path: '/api/queue/reorder', method: 'POST', body: { ids: ['a2', 'b1', 'a1'], ifRev: 7 } }])
    expect(desk.queue.value?.items.map((i) => i.id)).toEqual(['a2', 'b1', 'a1'])
  })

  test('a move at the end of its chat sends nothing', async () => {
    hello(queue(7, [item('a1'), item('b1', 'B')]))
    server(queue(99))
    expect(await desk.queueMove('a1', -1)).toBeNull()
    expect(await desk.queueMove('a1', 1)).toBeNull()
    expect(calls).toEqual([])
    expect(desk.queue.value?.rev).toBe(7)
  })

  test('resume and settings answer the queue, which is taken at once', async () => {
    hello(queue(3, [], { held: { 'chat/1': 'stopped' } }))
    server(queue(4))
    await desk.queueResume('chat/1')
    expect(calls[0]).toEqual({ path: '/api/queue/chats/chat%2F1/resume', method: 'POST', body: undefined })
    expect(desk.queue.value?.held).toEqual({})
    server(queue(5, [], { paused: true, sendMode: 'queue' }))
    await desk.queueSettings({ paused: true, sendMode: 'queue' })
    expect(calls[0]).toEqual({ path: '/api/queue', method: 'PATCH', body: { paused: true, sendMode: 'queue' } })
    expect(desk.queue.value?.paused).toBe(true)
    expect(desk.queue.value?.sendMode).toBe('queue')
  })

  test("a refusal rejects with the server's own words", async () => {
    server({ error: 'The queue changed in another window; try again.' }, 409)
    await expect(desk.queueEdit('a1', { text: 'x', ifRev: 1 })).rejects.toThrow('The queue changed in another window; try again.')
    server({}, 404)
    await expect(desk.queueRemove('gone')).rejects.toThrow('404')
  })
})

// Each click paints at once: the POST is held open here, so what shows is what the window drew before any answer.
function holdAnswer(): (r: Response) => void {
  let answerNow: (r: Response) => void = () => {}
  hold = new Promise<Response>((resolve) => (answerNow = resolve))
  return answerNow
}
function busyChat(id: string): ChatSummary {
  return { id, title: `Chat ${id}`, cwd: 'C:/work/queue', status: 'working' as const, turnStartedAt: 1, queuedCount: 0 } as unknown as ChatSummary
}

describe('a queued line and a send now paint at the click', () => {
  test('a queued line is in the queue before the POST answers; a refusal takes it back', async () => {
    hello(queue(1, [item('a1')]))
    const answerNow = holdAnswer()
    try {
      const added = desk.queueAdd({ kind: 'message', chatId: 'A', text: 'held text' })
      expect(desk.queue.value?.items.map((i) => i.text)).toEqual(['text a1', 'held text'])
      expect(desk.queue.value?.items[1]).toMatchObject({ kind: 'message', chatId: 'A', state: 'waiting' })
      answerNow(new Response(JSON.stringify({ error: 'The queue is paused.' }), { status: 409 }))
      await expect(added).rejects.toThrow('The queue is paused.')
    } finally {
      hold = null
    }
    expect(desk.queue.value?.items.map((i) => i.text)).toEqual(['text a1'])
  })

  test("the server's item takes the line's place when the POST answers", async () => {
    hello(queue(1, []))
    const answerNow = holdAnswer()
    try {
      const added = desk.queueAdd({ kind: 'message', chatId: 'A', text: 'next' })
      expect(desk.queue.value?.items).toHaveLength(1)
      answerNow(new Response(JSON.stringify(item('a9')), { status: 200 }))
      await added
    } finally {
      hold = null
    }
    expect(desk.queue.value?.items.map((i) => i.id)).toEqual(['a9'])
  })

  test('a send now shows the bubble before the POST answers; a refusal marks it Not sent and puts the queued line back', async () => {
    push({ type: 'hello', version: 't', chats: [busyChat('A')], settings: {} as DeskSettings, queue: queue(1) })
    desk.itemsByChat.value.set('A', []) // an open chat has its transcript loaded; the bubble goes into it
    server({ queued: true })
    await desk.send('A', { text: 'queued text' })
    const line = () => desk.itemsByChat.value.get('A')?.find((i): i is UserItem => i.kind === 'user' && i.text === 'queued text')
    expect(line()).toMatchObject({ queued: true })
    const id = line()!.id
    const answerNow = holdAnswer()
    try {
      const sent = desk.sendNow('A', id)
      expect(line()).toMatchObject({ queued: false })
      expect(line()?.sendFailed).toBeUndefined()
      answerNow(new Response(JSON.stringify({ error: 'Nothing is running.' }), { status: 409 }))
      await expect(sent).rejects.toThrow('Nothing is running.')
    } finally {
      hold = null
    }
    expect(line()).toMatchObject({ queued: true, sendFailed: 'Nothing is running.' })
  })

  test('a send now that stops the turn leaves the bubble sent', async () => {
    push({ type: 'hello', version: 't', chats: [busyChat('A')], settings: {} as DeskSettings, queue: queue(1) })
    desk.itemsByChat.value.set('A', [])
    server({ queued: true })
    await desk.send('A', { text: 'stop for this' })
    const line = () => desk.itemsByChat.value.get('A')?.find((i): i is UserItem => i.kind === 'user' && i.text === 'stop for this')
    server({ ok: true, stopped: true })
    await desk.sendNow('A', line()!.id)
    expect(line()).toMatchObject({ queued: false })
    expect(line()?.sendFailed).toBeUndefined()
  })
})

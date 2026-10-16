// server/tests/climayte-deliver.test.ts — a message for a running worker goes into its live CLI mid-turn
// through the native runner's /deliver: accepted, refused, held when there is no live input yet, and
// requeued when the CLI's turn ends before it reads it. The runner is a local HTTP stand-in here.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { climayteSend, requeueUnread } from '../src/climayte'
import { workers } from '../src/climayte-core'
import type { CliMayteWorker } from '../src/climayte-lib'
import { HELD_MESSAGE } from '../src/climayte-steer'

const root = mkdtempSync(join(tmpdir(), 'ah-climayte-deliver-'))
const TOKEN = 'deliver-token-for-test'
let answer = 200
const got: { token: string | null; body: { requestId: string; text: string } }[] = []

const runner = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== '/deliver') return new Response('', { status: 404 })
    got.push({
      token: req.headers.get('x-climayte-deliver-token'),
      body: (await req.json()) as { requestId: string; text: string },
    })
    return new Response(answer === 200 ? '{"ok":true}' : 'refused', { status: answer })
  },
})

const runnerPort = runner.port ?? 0

const made: string[] = []

afterAll(() => {
  for (const id of made) workers.delete(id)
  runner.stop(true)
  rmSync(root, { recursive: true, force: true })
})

function running(id: string, port: number | null): CliMayteWorker {
  const portFile = join(root, `${id}.port`)
  if (port !== null) writeFileSync(portFile, String(port))
  const w = {
    id,
    status: 'running',
    pending: [],
    sendIds: [],
    cwd: root,
    model: null,
    effort: null,
    chat: false,
    sealed: false,
    attempts: [
      {
        account: { id: `acct-${id}`, num: 1, name: 'test', configDir: root },
        log: join(root, `${id}.jsonl`),
        errLog: join(root, `${id}.err.log`),
        pid: 1,
        startedAt: Date.now(),
        endedAt: null,
        outcome: 'running',
        notice: null,
        resumed: false,
        deliver: { token: TOKEN, portFile, delivered: join(root, `${id}.delivered.jsonl`) },
        deliveries: [],
      },
    ],
  } as unknown as CliMayteWorker
  made.push(id)
  workers.set(id, w)
  return w
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe('a message for a running worker reaches its live CLI in the turn', () => {
  test('accepted by the runner: posted with the token, kept as delivered, not held', async () => {
    answer = 200
    got.length = 0
    const w = running('w-accept', runnerPort)
    const r = climayteSend(w.id, 'Use the other file.', { requestId: 'req-1' })
    expect(r.ok).toBe(true)
    expect(r.delivered).toBe('in-turn')
    await settle()
    expect(got).toEqual([
      { token: TOKEN, body: { requestId: 'req-1', text: 'Use the other file.' } },
    ])
    expect(w.attempts[0]?.deliveries).toEqual([
      { requestId: 'req-1', text: 'Use the other file.', accepted: true },
    ])
    expect(w.pending).toEqual([])
  })

  test('refused by the runner (its stdin is closed): held again, not lost', async () => {
    answer = 409
    got.length = 0
    const w = running('w-refused', runnerPort)
    const r = climayteSend(w.id, 'Look at the logs too.', { requestId: 'req-2' })
    expect(r.delivered).toBe('in-turn')
    await settle()
    expect(got.length).toBe(1)
    expect(w.attempts[0]?.deliveries).toEqual([])
    expect(w.pending).toEqual(['Look at the logs too.'])
    answer = 200
  })

  test('no port file yet: the message is held as before', () => {
    const w = running('w-noport', null)
    const r = climayteSend(w.id, 'Wait for my review.', { requestId: 'req-3' })
    expect(r.delivered).toBeUndefined()
    expect(r.message).toBe(HELD_MESSAGE)
    expect(w.pending).toEqual(['Wait for my review.'])
  })

  test('accepted but never echoed by the CLI: requeued when the attempt ends; echoed ones are not', () => {
    const w = running('w-unread', null)
    const at = w.attempts[0]!
    at.deliveries = [
      { requestId: 'a', text: 'first', accepted: true },
      { requestId: 'b', text: 'second', accepted: true },
    ]
    const events = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    ]
    requeueUnread(w, at, events)
    expect(w.pending).toEqual(['second'])
    expect(at.deliveries).toEqual([])
  })
})

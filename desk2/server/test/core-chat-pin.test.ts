// core/src/chat.ts at its Chats boundary, with a real Store in a temp folder and a stand-in Claude backend: the owner's
// account pin and its Auto switch (owner, 2026-10-15: "pin the orchestrator to a single account ... a little toggle ...
// Auto ... if that account is no longer available, it'll just move it to the next available account"), and a new chat
// made from the window, whose prompt and setting the core used to drop.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '@shared/protocol'
import { Chats } from '../../../core/src/chat'
import { Store } from '../../../core/src/store'
import type { Account, Accounts, Backend, Task, TurnEnd } from '../../../core/src/types'

const A: Account = { id: 'acct-a', service: 'claude', label: '#1 alpha', home: 'C:/a', room: 60 }
const B: Account = { id: 'acct-b', service: 'claude', label: '#2 beta', home: 'C:/b', room: 90 }

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A core over two accounts; a turn on `limited` ends in a usage limit, any other replies and binds a session there. */
function core(limited: string | null = null) {
  const home = mkdtempSync(join(tmpdir(), 'core-pin-'))
  temps.push(home)
  const holds = new Map<string, number>()
  const ran: { account: string; task: Task }[] = []
  const accounts: Accounts = {
    async pick(_service, avoid) {
      return [B, A].find((a) => !avoid.has(a.id) && (holds.get(a.id) ?? 0) <= Date.now()) ?? { why: 'No Claude account has room now.' }
    },
    async find(_service, id) {
      return [A, B].find((a) => a.id === id) ?? null
    },
    heldUntil: (id) => holds.get(id) ?? 0,
    hold: (id, until) => void holds.set(id, until),
    async list() {
      return [A, B]
    },
  }
  const claude: Backend = {
    service: 'claude',
    start(task, account, sink) {
      ran.push({ account: account.id, task })
      if (account.id === limited) {
        const end: TurnEnd = { ok: false, error: "You've hit your limit", limitedUntil: Date.now() + 3_600_000 }
        return { done: Promise.resolve(end), interrupt() {} }
      }
      sink.thread({ accountId: account.id, label: account.label, threadId: `session-${account.id}-${ran.length}` })
      sink.item({ kind: 'assistant_text', id: `reply-${ran.length}`, ts: Date.now(), text: `Reply ${ran.length}` })
      return { done: Promise.resolve({ ok: true }), interrupt() {} }
    },
    async release() {},
  }
  const history = { list: async () => [], find: async () => null, tail: async () => null, older: async () => null }
  const chats = new Chats({ store: new Store(home), accounts, history, backends: [claude], emit: () => {} })
  return { chats, ran, cwd: home }
}

/** Resolves once the chat has no turn starting or running. */
async function settled(chats: Chats, id: string) {
  for (let i = 0; i < 200; i++) {
    const s = chats.get(id).status
    if (s !== 'starting' && s !== 'working') return chats.get(id)
    await Bun.sleep(5)
  }
  throw new Error('the turn never ended')
}

test('Auto off: a limit on the chosen account leaves the chat on it, limited until the reset, and runs nothing elsewhere', async () => {
  const { chats, ran, cwd } = core('acct-a')
  const made = await chats.create({ cwd, prompt: 'hello', accountId: 'acct-a', accountPinned: true })
  const chat = await settled(chats, made.id)
  expect(ran.map((r) => r.account)).toEqual(['acct-a'])
  expect(chat.status).toBe('limited')
  expect(chat.account.id).toBe('acct-a')
  expect(chat.limitResetsAt).toBeGreaterThan(Date.now())

  // The next message waits for that reset too: it says so and still goes nowhere else.
  chats.send(made.id, { text: 'again' })
  const after = await settled(chats, made.id)
  expect(ran.map((r) => r.account)).toEqual(['acct-a'])
  expect(after.status).toBe('limited')
  expect(after.lastError).toContain('Auto is off')
})

test('Auto on: the same limit moves the turn to the next account with room', async () => {
  const { chats, ran, cwd } = core('acct-a')
  const made = await chats.create({ cwd, prompt: 'hello', accountId: 'acct-a' })
  const chat = await settled(chats, made.id)
  expect(ran.map((r) => r.account)).toEqual(['acct-a', 'acct-b'])
  expect(chat.status).toBe('idle')
  expect(chat.account.id).toBe('acct-b')
})

test('a new chat runs its prompt on the model and effort it was made with; one that names none runs the defaults', async () => {
  const { chats, ran, cwd } = core()
  const named = await chats.create({ cwd, prompt: 'first', model: 'claude-sonnet-5-5', effort: 'high' })
  await settled(chats, named.id)
  const plain = await chats.create({ cwd, prompt: 'second' })
  await settled(chats, plain.id)
  expect(ran.map((r) => [r.task.text, r.task.model, r.task.effort])).toEqual([
    ['first', 'claude-sonnet-5-5', 'high'],
    ['second', DEFAULT_MODEL, DEFAULT_EFFORT],
  ])
})

test('moving a chat with a session to another account starts a new session there that reads the chat first', async () => {
  const { chats, ran, cwd } = core()
  const made = await chats.create({ cwd, prompt: 'one', accountId: 'acct-a' })
  await settled(chats, made.id)
  expect(chats.get(made.id).sessionId).toBe('session-acct-a-1')

  await chats.patch(made.id, { accountId: 'acct-b' })
  chats.send(made.id, { text: 'two' })
  await settled(chats, made.id)
  const moved = ran[1]!
  expect(moved.account).toBe('acct-b')
  // A session lives on its login: none is resumed on the new one, and the turn opens with the chat so far.
  expect(moved.task.thread).toBeUndefined()
  expect(moved.task.text).toContain('Reply 1')
  expect(moved.task.text.endsWith('two')).toBe(true)
})

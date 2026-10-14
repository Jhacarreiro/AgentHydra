// Pin service: a chat pinned to Codex runs each of its messages as a turn of a Codex thread on one of the owner's
// Codex accounts (a fake app-server here), and the turn's reply, commands and approvals land in the chat as any
// chat's do. A usage limit moves the message to another Codex account, whose new thread first reads a condensed
// handoff of the chat; pinned back to Claude, the next message carries what was said on Codex. A Codex chat run
// outside Desk continues here the same way, in its own thread on the account that holds it.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo, ExternalSession, ServerEvent, TranscriptItem } from '@shared/protocol'
import type { AhCodexInstance } from '../../../src/bridge/client'
import { ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import type { CodexDirectory } from '../../../src/engine/codex/accounts'
import type { OpenAppServer, ThreadListener } from '../../../src/engine/codex/app-server'
import { ANSWER_NOW, PIN_INTRO } from '../../../src/engine/handoff'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const ALPHA: AhCodexInstance = { id: 'cx-alpha', num: 7, name: 'alpha', codexHome: 'C:/Users/me/.agenthydra/codex-instances/cx-alpha', loggedIn: true }
const BETA: AhCodexInstance = { id: 'cx-beta', num: 8, name: 'beta', codexHome: 'C:/Users/me/.agenthydra/codex-instances/cx-beta', loggedIn: true }

/** App-servers the test drives: each records its calls and holds the thread listeners Desk registers. */
function fakeCodex() {
  const servers: { home: string; calls: { method: string; params: Record<string, unknown> }[]; listeners: Map<string, ThreadListener> }[] = []
  let threads = 0
  let turns = 0
  const open: OpenAppServer = async (home) => {
    const s = { home, calls: [] as { method: string; params: Record<string, unknown> }[], listeners: new Map<string, ThreadListener>() }
    servers.push(s)
    return {
      call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        s.calls.push({ method, params })
        if (method === 'thread/start') return { thread: { id: `thread-${++threads}` } } as T
        if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } } as T
        return {} as T
      },
      listen: (threadId, l) => {
        s.listeners.set(threadId, l)
        return () => s.listeners.delete(threadId)
      },
      release: () => {},
    }
  }
  const turnStarts = () => servers.flatMap((s) => s.calls.filter((c) => c.method === 'turn/start').map((c) => ({ home: s.home, ...c.params }) as { home: string; threadId: string; input: { text?: string }[] }))
  const thread = (id: string): ThreadListener => servers.findLast((s) => s.listeners.has(id))!.listeners.get(id)!
  const calls = (method: string) => servers.flatMap((s) => s.calls.filter((c) => c.method === method).map((c) => ({ home: s.home, ...c.params })))
  return { open, turnStarts, thread, calls }
}

async function setup(o: { external?: ExternalSession[]; items?: Record<string, TranscriptItem[]> } = {}) {
  const home = temp('desk-pin-home-')
  const cwd = temp('desk-pin-cwd-')
  mkdirSync(cwd, { recursive: true })
  process.env.HYDRA_DESK_HOME = home
  const account: AccountInfo = { id: 'acct-1', label: '#1 user (Pro)', configDir: temp('desk-pin-acct-'), number: 1, email: null, plan: 'Pro', signedIn: true, fiveHourPct: 10, weeklyPct: 10, fiveHourResetsAt: null, weeklyResetsAt: null, inUse: false }
  const codex: CodexDirectory = {
    instances: async () => [ALPHA, BETA],
    usage: async (id) => ({ snapshot: { session: { pct: id === ALPHA.id ? 10 : 40 }, weekAll: { pct: 5 } } }),
  }
  const fake = fakeCodex()
  const q = fakeQueries()
  const events: ServerEvent[] = []
  const bridge: ManagerBridge = { ...fakeBridge({ roots: [], external: o.external, items: o.items }).bridge, listAccounts: async () => [account] }
  const m = new ChatManager({ home, claudeHome: home, emit: (e) => events.push(e), settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk', codex, openCodex: fake.open })
  managers.push(m)
  const chat = await m.create({ cwd, title: 'Pinned', accountId: 'acct-1', permissionMode: 'bypassPermissions' })
  return { m, q, fake, chat, cwd }
}

const systemTexts = (items: TranscriptItem[]) => items.flatMap((i) => (i.kind === 'system' ? [i.text] : []))

/** One Codex turn that replies `reply` and completes. */
async function codexTurn(fake: ReturnType<typeof fakeCodex>, m: ChatManager, chatId: string, text: string, reply: string) {
  const n = fake.turnStarts().length
  await m.send(chatId, text)
  await waitFor(() => fake.turnStarts().length > n)
  const start = fake.turnStarts().at(-1)!
  const turnId = `turn-${fake.turnStarts().length}`
  const l = fake.thread(start.threadId)
  l.notify('item/agentMessage/delta', { threadId: start.threadId, turnId, itemId: `msg-${turnId}`, delta: reply })
  l.notify('item/completed', { threadId: start.threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: reply } })
  l.notify('turn/completed', { threadId: start.threadId, turn: { id: turnId, status: 'completed', durationMs: 900 } })
  await waitFor(() => m.get(chatId).status === 'idle')
  return start
}

test("a chat pinned to Codex runs its message on the emptiest Codex account, and the turn's command, approval and reply land in the chat", async () => {
  const { m, fake, chat } = await setup()
  expect((await m.services()).map((s) => [s.kind, s.ready, s.accounts])).toEqual([
    ['claude', true, 1],
    ['codex', true, 2],
    ['chatgpt', false, 0],
  ])
  await m.patch(chat.id, { service: 'codex' })
  expect(m.get(chat.id).service).toBe('codex')
  expect(systemTexts(m.listItems(chat.id))).toContain('This chat now runs on Codex.')

  await m.send(chat.id, 'Show me the status')
  await waitFor(() => fake.turnStarts().length === 1)
  const start = fake.turnStarts()[0]!
  // The emptiest account (alpha, 10% against 40%), the chat's own folder, its permission mode as Codex's policy.
  expect(start.home).toBe(ALPHA.codexHome)
  expect(start.input[0]!.text).toBe('Show me the status')
  expect(start).toMatchObject({ threadId: 'thread-1', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })

  const l = fake.thread('thread-1')
  const command = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git status'`
  l.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
  l.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command, status: 'inProgress' } })
  const answer = l.request('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command, reason: 'It reads the repository.' })
  await waitFor(() => m.get(chat.id).status === 'needs_you')
  const ask = m.listItems(chat.id).find((i) => i.kind === 'permission')!
  expect(ask).toMatchObject({ toolName: 'PowerShell', input: { command: 'git status' }, reason: 'It reads the repository.', state: 'pending' })
  m.respondPermission(chat.id, ask.id, { decision: 'allow' })
  expect(await answer).toEqual({ decision: 'accept' })

  l.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command, status: 'completed', aggregatedOutput: 'nothing to commit', exitCode: 0 } })
  l.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'All ' })
  l.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'clean.' })
  l.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'All clean.' } })
  l.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', durationMs: 1200 } })
  await waitFor(() => m.get(chat.id).status === 'idle')

  const items = m.listItems(chat.id)
  expect(items.find((i) => i.kind === 'tool_use' && i.id === 'cmd-1')).toMatchObject({ name: 'PowerShell', input: { command: 'git status' }, status: 'done', result: { text: 'nothing to commit', isError: false } })
  expect(items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'allowed' })
  expect(items.filter((i) => i.kind === 'assistant_text').map((i) => i.text)).toEqual(['All clean.'])
  expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: true, durationMs: 1200 })
  expect(m.get(chat.id).serviceThreads?.codex).toEqual({ accountId: ALPHA.id, label: '#7 alpha', threadId: 'thread-1' })
})

test("a usage limit moves the message to another Codex account, whose new thread first reads the chat's record", async () => {
  const { m, fake, chat } = await setup()
  await m.patch(chat.id, { service: 'codex' })
  await codexTurn(fake, m, chat.id, 'Plan the release', 'Three steps: build, test, tag.')

  await m.send(chat.id, 'Do step one')
  await waitFor(() => fake.turnStarts().length === 2)
  fake.thread('thread-1').notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'failed', error: { message: 'You hit your limit.', codexErrorInfo: 'usageLimitExceeded' } } })
  await waitFor(() => fake.turnStarts().length === 3)

  const moved = fake.turnStarts()[2]!
  expect(moved.home).toBe(BETA.codexHome)
  expect(moved.threadId).toBe('thread-2')
  const text = moved.input[0]!.text!
  expect(text.startsWith(`${PIN_INTRO}Codex, which has not seen it yet: until now it ran on another Codex account (#7 alpha).`)).toBe(true)
  expect(text).toContain('Three steps: build, test, tag.')
  expect(text.endsWith(`${ANSWER_NOW}Do step one`)).toBe(true)
  expect(systemTexts(m.listItems(chat.id))).toContain('#7 alpha hit its Codex usage limit, so this chat goes on on another Codex account.')
  expect(m.get(chat.id).serviceThreads?.codex?.accountId).toBe(BETA.id)
})

test('pinned back to Claude, the next message carries what was said on Codex, and shows only what was typed', async () => {
  const { m, q, fake, chat } = await setup()
  await m.patch(chat.id, { service: 'codex' })
  await codexTurn(fake, m, chat.id, 'Name the module', 'Call it ledger.')
  await m.patch(chat.id, { service: null })
  expect(systemTexts(m.listItems(chat.id))).toContain('This chat runs on Claude again.')

  await m.send(chat.id, 'Write it')
  await waitFor(() => q.all.length === 1 && q.last().sent.length === 1)
  const sent = JSON.stringify(q.last().sent[0]!.message.content)
  expect(sent).toContain(`${PIN_INTRO}Claude, which has not seen it yet: until now it ran on Codex.`)
  expect(sent).toContain('Call it ledger.')
  const items = m.listItems(chat.id)
  expect(items.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['Name the module', 'Write it'])
  expect(systemTexts(items)).toContain('Caught up on what was said on Codex.')
  // Caught up: the message after it carries nothing.
  expect(m.get(chat.id).serviceLeftAt?.claude).toBeUndefined()
})

test('a Codex chat run outside Desk continues here in its own thread, on the account that holds it, with no hand-off', async () => {
  const threadId = '0f0f0f0f-1111-4222-8333-444444444444'
  const earlier: TranscriptItem[] = [
    { kind: 'user', id: 'u-1', ts: 1, text: 'What changed?' },
    { kind: 'assistant_text', id: 'a-1', ts: 2, text: 'Two files.' },
  ]
  const outside = (cwd: string): ExternalSession => ({ id: threadId, title: 'From Codex', cwd, source: 'codex', instance: '#8 beta', status: 'idle', activity: null, lastActivityAt: 2, model: null, accountId: null, codexAccountId: BETA.id, canResume: true, fromPc: null, pinned: false, archived: false, unread: false, group: null })
  const cwd = temp('desk-pin-outside-')
  const { m, fake } = await setup({ external: [outside(cwd)], items: { [threadId]: earlier } })

  const chat = await m.importSession({ sessionId: threadId })
  expect(chat).toMatchObject({ service: 'codex', sessionId: null, cwd, serviceThreads: { codex: { accountId: BETA.id, label: '#8 beta', threadId } } })
  // A second import (another window) lands on the same chat; a fork is refused in a sentence.
  expect((await m.importSession({ sessionId: threadId })).id).toBe(chat.id)
  await expect(m.importSession({ sessionId: threadId, fork: true })).rejects.toThrow('This Codex chat continues in place: Fork works on Claude chats.')

  const start = await codexTurn(fake, m, chat.id, 'Carry on', 'Carrying on.')
  // Its own thread, resumed where it lives: the thread holds its history, so the message goes as typed.
  expect(start).toMatchObject({ home: BETA.codexHome, threadId })
  expect(start.input[0]!.text).toBe('Carry on')
  expect(fake.calls('thread/resume')).toEqual([expect.objectContaining({ home: BETA.codexHome, threadId })])
  expect(fake.calls('thread/start')).toEqual([])
  expect(m.listItems(chat.id).filter((i) => i.kind === 'assistant_text').map((i) => i.text)).toEqual(['Two files.', 'Carrying on.'])
})

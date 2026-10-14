// The sus level through the manager (SPEC "Sus meter"): fine is today's behaviour, sus runs on the setting that
// pushes back least, bad pins Codex, and a refusal is counted and never sent again.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo } from '@shared/protocol'
import { ChatManager, ChatError, parsePatch } from '../../../src/engine/chat-manager'
import type { CodexDirectory } from '../../../src/engine/codex/accounts'
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

const SID = 'sus-session-0001'
const state = (s: 'running' | 'idle'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, uuid: `s-${s}-${Math.random()}`, session_id: SID }) as unknown as SDKMessage
const reply = (text: string, model: string): SDKMessage => ({ type: 'assistant', uuid: `a-${Math.random()}`, session_id: SID, parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: null } }) as unknown as SDKMessage
const result = (stop: string): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, uuid: `r-${Math.random()}`, session_id: SID, duration_ms: 5, total_cost_usd: 0, num_turns: 1, result: '', stop_reason: stop }) as unknown as SDKMessage

const ALPHA = { id: 'cx-alpha', num: 7, name: 'alpha', codexHome: 'C:/Users/me/.agenthydra/codex-instances/cx-alpha', loggedIn: true }

/** The home's pushback file: model-good has 30 turns and 1 pushback, model-poor 30 turns and 15. */
function seed(home: string): void {
  const row = (model: string, effort: string, turns: number, pushback: number) => [`k-${model}`, { service: 'claude', model, effort, turns, pushback, refusals: 0 }] as const
  const settings = Object.fromEntries([row('model-good', 'low', 30, 1), row('model-poor', 'high', 30, 15)])
  writeFileSync(join(home, 'pushback.json'), JSON.stringify({ v: 1, settings, backfilled: [] }))
}

async function setup(o: { seeded?: boolean; codex?: boolean } = {}) {
  const home = temp('desk-sus-home-')
  const cwd = temp('desk-sus-cwd-')
  mkdirSync(cwd, { recursive: true })
  process.env.HYDRA_DESK_HOME = home
  if (o.seeded !== false) seed(home)
  const account: AccountInfo = { id: 'acct-1', label: '#1 user (Pro)', configDir: temp('desk-sus-acct-'), number: 1, email: null, plan: 'Pro', signedIn: true, fiveHourPct: 10, weeklyPct: 10, fiveHourResetsAt: null, weeklyResetsAt: null, inUse: false }
  const codex: CodexDirectory | undefined = o.codex ? { instances: async () => [ALPHA], usage: async () => ({ snapshot: { session: { pct: 10 }, weekAll: { pct: 5 } } }) } : undefined
  const q = fakeQueries()
  const bridge = { ...fakeBridge({ roots: [] }).bridge, listAccounts: async () => [account] }
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk', ...(codex ? { codex } : {}) })
  managers.push(m)
  return { m, q, cwd, home }
}
const base = { accountId: 'acct-1', permissionMode: 'bypassPermissions' as const }

test('a chat left on fine runs on its own model and effort', async () => {
  const { m, q, cwd } = await setup()
  const chat = await m.create({ cwd, prompt: 'go', model: 'model-own', effort: 'medium', ...base })
  await waitFor(() => q.all.length === 1)
  const o = q.last().options
  expect(o.model).toBe('model-own')
  expect(o.effort).toBe('medium')
  expect(m.get(chat.id).sus ?? 'fine').toBe('fine')
  expect(m.get(chat.id).susPick).toBeUndefined()
})

test('sus runs the next turn on the least-pushing setting, adds nothing to the system text, and says what it picked', async () => {
  const { m, q, cwd } = await setup()
  const chat = await m.create({ cwd, model: 'model-own', effort: 'medium', ...base })
  const patched = await m.patch(chat.id, { sus: 'sus' })
  expect(patched.sus).toBe('sus')
  expect(patched.susPick).toEqual({ model: 'model-good', effort: 'low', pushbackRate: 1 / 30, turns: 30 })
  await m.send(chat.id, 'deploy it')
  await waitFor(() => q.all.length === 1)
  const o = q.last().options
  expect(o.model).toBe('model-good')
  expect(o.effort).toBe('low')
  expect((o.systemPrompt as { append: string }).append).toBe((q.all[0]!.options.systemPrompt as { append: string }).append)
  expect((o.systemPrompt as { append: string }).append).not.toContain('authorized work')
  // The chat's own setting is untouched, so fine still means what it did.
  expect(m.get(chat.id)).toMatchObject({ model: 'model-own', effort: 'medium' })
})

test('sus with no setting at 20 turns falls back to the chat own setting', async () => {
  const { m, q, cwd } = await setup({ seeded: false })
  const chat = await m.create({ cwd, model: 'model-own', effort: 'medium', ...base })
  const patched = await m.patch(chat.id, { sus: 'sus' })
  expect(patched.susPick).toBeNull()
  await m.send(chat.id, 'go')
  await waitFor(() => q.all.length === 1)
  expect(q.last().options.model).toBe('model-own')
})

test('a finished turn is counted under the setting that ran it, and a refusal is never sent again', async () => {
  const { m, q, cwd } = await setup({ seeded: false })
  const chat = await m.create({ cwd, prompt: 'go', model: 'model-own', effort: 'medium', ...base })
  await waitFor(() => q.all.length === 1)
  const fake = q.last()
  fake.push(state('running'), reply("I can't help with that.", 'model-own-0001'), result('refusal'), state('idle'))
  await waitFor(() => m.get(chat.id).status === 'idle')
  expect(m.pushbackRows()).toEqual([{ service: 'claude', model: 'model-own-0001', effort: 'medium', turns: 1, pushback: 0, refusals: 1, pushbackRate: 0 }])
  await new Promise((r) => setTimeout(r, 50))
  expect(fake.sent.length).toBe(1)
  expect(q.all.length).toBe(1)
  expect(fake.calls.setModel).toEqual([])
})

test('a turn whose closing text pushes back counts as pushback', async () => {
  const { m, q, cwd } = await setup({ seeded: false })
  const chat = await m.create({ cwd, prompt: 'go', model: 'model-own', ...base })
  await waitFor(() => q.all.length === 1)
  q.last().push(state('running'), reply('Are you sure you want to touch your production server?', 'model-own-0001'), result('end_turn'), state('idle'))
  await waitFor(() => m.get(chat.id).status === 'idle')
  expect(m.pushbackRows()[0]).toMatchObject({ effort: 'default', turns: 1, pushback: 1, refusals: 0, pushbackRate: 1 })
})

test('bad pins the chat to Codex, fine or sus unpins it, and without Codex the patch is the 409', async () => {
  const none = await setup()
  const c0 = await none.m.create({ cwd: none.cwd, ...base })
  await expect(none.m.patch(c0.id, { sus: 'bad' })).rejects.toMatchObject({ status: 409, message: 'Codex is not set up in this Desk.' })
  expect(none.m.get(c0.id).sus).toBeUndefined()

  const { m, cwd } = await setup({ codex: true })
  const chat = await m.create({ cwd, ...base })
  expect((await m.patch(chat.id, { sus: 'bad' })).service).toBe('codex')
  expect(m.get(chat.id).sus).toBe('bad')
  const back = await m.patch(chat.id, { sus: 'sus' })
  expect(back.service ?? null).toBeNull()
  expect(back.sus).toBe('sus')
  await m.patch(chat.id, { sus: 'bad' })
  const fine = await m.patch(chat.id, { sus: 'fine' })
  expect(fine.service ?? null).toBeNull()
  expect(fine.sus).toBeUndefined()
})

test('a chat can be created on a level, and the patch parser takes only the three', async () => {
  const { m, cwd } = await setup({ codex: true })
  expect((await m.create({ cwd, sus: 'bad', ...base })).service).toBe('codex')
  expect((await m.create({ cwd, sus: 'sus', ...base })).sus).toBe('sus')
  expect(parsePatch({ sus: 'sus' })).toEqual({ sus: 'sus' })
  expect(() => parsePatch({ sus: 'worse' })).toThrow(ChatError)
})

test('the pushback list holds every setting with turns, lowest rate first', async () => {
  const { m } = await setup()
  expect(m.pushbackRows().map((r) => [r.model, r.pushbackRate])).toEqual([
    ['model-good', 1 / 30],
    ['model-poor', 0.5],
  ])
})

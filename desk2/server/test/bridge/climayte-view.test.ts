import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type AhWorker } from '../../src/bridge/client'
import { mapWorkers, missingAncestors, workersOfChat } from '../../src/bridge/climayte'
import { mapExternal } from '../../src/bridge/external'
import { createWorkerTokens } from '../../src/bridge/worker-tokens'
import { workerAccount, workerChatStatus, workerTurnSetting } from '../../src/engine/chat-worker-status'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const raw = (): AhWorker => ({
  id: 'bridge-worker', group: 'bridge-group', title: 'Synthetic task', cwd: '/synthetic/current',
  pendingCwd: '/synthetic/next', prompt: 'Synthetic task description', status: 'running',
  sessionId: 'current-session', sessions: ['old-session'], accountId: 'current-account', account: '#2 Example',
  model: 'claude-sonnet-5-5', reportedModel: 'claude-opus-5-5', effort: 'medium', kind: 'code', chat: true,
  result: null, error: null, lastActivity: 'Reading the synthetic fixture', doing: 'Reading',
  doingSince: NOW - 100, doingKind: 'step', lastStepAt: NOW - 100, notBefore: null,
  createdAt: NOW - 1000, updatedAt: NOW,
  origin: { kind: 'chat', sessionId: 'parent-session' }, wave: 'synthetic-wave', hold: 'wave',
  question: { text: 'Choose an option', options: ['A', 'B'], at: NOW },
  eta: { minutes: 1, at: NOW - 1000, attempt: 1 }, used: { pct: 3.5 }, verdicts: [{ verdict: 'pass' }],
  attempts: [
    { account: { id: 'old-account', num: 1, name: 'Old example' }, outcome: 'quota' },
    { account: { id: 'current-account', num: 2, name: 'Example' }, outcome: 'running' },
  ],
})

test('every bridge list selector asks for the additive projection while old daemons can ignore it', async () => {
  const calls: URL[] = []
  const old = { ...raw(), pending: ['Synthetic queued message'], costUsd: 1, resultChars: 20 }
  const client = createClient({
    url: 'http://hydra.example.test',
    fetch: (async (request) => {
      calls.push(new URL(String(request)))
      // A previous daemon ignores the new flag and still answers the old lean shape.
      return Response.json([old])
    }) as typeof fetch,
  })
  expect(await client.workers()).toEqual([old])
  expect(await client.workers({ limit: 20, group: 'group / example', origin: ['origin-a', 'origin-b'] })).toEqual([old])
  expect(await client.workersByIds(['worker/a', 'worker-b'])).toEqual([old])
  expect(await client.workersBySession(['session/a', 'session-b'])).toEqual([old])
  for (const url of calls) {
    expect(url.pathname).toBe('/api/corch/workers')
    expect(url.searchParams.get('lean')).toBe('1')
    expect(url.searchParams.get('bridge')).toBe('1')
  }
  expect(calls[1]!.searchParams.get('limit')).toBe('20')
  expect(calls[1]!.searchParams.get('group')).toBe('group / example')
  expect(calls[1]!.searchParams.get('origin')).toBe('origin-a,origin-b')
  expect(calls[2]!.searchParams.get('ids')).toBe('worker/a,worker-b')
  expect(calls[3]!.searchParams.get('session')).toBe('session/a,session-b')
})

test('bridge contract and older lean extras produce identical rows, hooks, ancestry and chat-manager values', () => {
  const bridge = [raw(), { ...raw(), id: 'child', origin: { kind: 'worker' as const, workerId: 'bridge-worker' }, chat: undefined, question: undefined }]
  const old = bridge.map((w) => ({ ...w, pending: ['Synthetic follow-up'], desk: { append: 'Unused launch text', mcpServers: {} }, resultChars: 20, used: { ...w.used!, workPct: 3, rereadPct: 0.5 }, verdicts: w.verdicts?.map((v) => ({ ...v, note: 'Unused hover note', by: 'owner' })) }))
  expect(mapWorkers(bridge)).toEqual(mapWorkers(old))
  expect(missingAncestors(bridge)).toEqual(missingAncestors(old))
  expect(workersOfChat(mapWorkers(bridge), { sessionId: 'parent-session' })).toEqual(workersOfChat(mapWorkers(old), { sessionId: 'parent-session' }))
  const hooks = [{ sessionId: 'current-session', at: new Date(NOW).toISOString(), state: 'blocked', activity: 'Synthetic permission request' }]
  const external = (workers: AhWorker[]) => mapExternal({ workers, agentStatus: hooks as never, live: [], chats: [], sessions: [] }, new Set(), NOW)
  expect(external(bridge)).toEqual(external(old))
  expect(external(bridge)[0]).toMatchObject({ id: 'current-session', model: 'claude-opus-5-5', accountId: 'current-account' })
  for (let i = 0; i < bridge.length; i++) {
    expect(workerChatStatus(bridge[i]!)).toEqual(workerChatStatus(old[i]!))
    expect(workerTurnSetting(bridge[i]!)).toEqual(workerTurnSetting(old[i]!))
    expect(workerAccount(bridge[i]!)).toEqual(workerAccount(old[i]!))
  }
})

test('all account moves and prior sessions still contribute live transcript tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-bridge-projection-'))
  try {
    const oldDir = join(dir, 'old-account')
    const currentDir = join(dir, 'current-account')
    for (const [account, session, input] of [[oldDir, 'old-session', 30], [currentDir, 'current-session', 40]] as const) {
      const project = join(account, 'projects', 'synthetic-project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, `${session}.jsonl`), JSON.stringify({ type: 'assistant', message: { id: `message-${session}`, usage: { input_tokens: input, output_tokens: 1 } } }) + '\n')
    }
    const w = raw()
    const list = mapWorkers([w])
    await createWorkerTokens().apply(list, [w], new Map([['old-account', oldDir], ['current-account', currentDir]]))
    expect(list[0]!.tokens).toBe(72)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

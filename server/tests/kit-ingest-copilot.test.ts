// server/tests/kit-ingest-copilot.test.ts - VS Code's Copilot Chat logs become `vscode-copilot` calls in the
// usage ledger (kit/ingest-copilot.ts).
//
// THE GAP THIS PINS. The ledger counted every tool on the owner's PC but Copilot Chat in VS Code, whose
// chats are VS Code operation logs (a whole-chat line, then sets and pushes at paths). Each request the log
// ever showed is one call, tokens only where VS Code or Copilot wrote them. Every file is invented and built
// in a scratch folder.

import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copilotModel, copilotProvider, cwdKey, ingestCopilot } from '../src/kit/ingest-copilot'
import { ingestForeign } from '../src/kit/ingest-foreign'
import { KitStore } from '../src/kit/store'

const root = mkdtempSync(join(tmpdir(), 'kit-copilot-'))
const stores: KitStore[] = []
afterAll(() => {
  for (const s of stores) s.close()
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // a Windows handle still draining: the OS temp cleaner takes it
  }
})

const NOW = Date.now()
const T1 = NOW - 30 * 60_000
const T2 = NOW - 20 * 60_000
const T3 = NOW - 10 * 60_000
const jl = (...ops: unknown[]) => ops.map((o) => `${JSON.stringify(o)}\n`).join('')

function newStore(): KitStore {
  const s = new KitStore(':memory:')
  stores.push(s)
  return s
}

interface Row {
  id: string
  ts: number
  session: string
  model: string
  provider: string
  input: number
  output: number
  cache_read: number
}
const rows = (s: KitStore): Row[] =>
  s.db.query("select * from usage_event where source = 'vscode-copilot' order by id").all() as Row[]
const byId = (s: KitStore) => new Map(rows(s).map((r) => [r.id, r]))

/** A request as VS Code writes it: the counted fields plus the text and parts the ingest drops. */
const request = (id: string, at: number, modelId: string, extra: Record<string, unknown> = {}) => ({
  requestId: id,
  timestamp: at,
  modelId,
  message: { text: 'Example prompt text' },
  variableData: { variables: [] },
  response: [{ value: 'Example answer text' }],
  ...extra,
})

const summary = (round: string, prompt: number, cached: number, output: number) => ({
  toolCallRoundId: round,
  text: 'Example summary text',
  model: 'claude-sonnet-4.6',
  usage: {
    prompt_tokens: prompt,
    completion_tokens: output,
    prompt_tokens_details: { cached_tokens: cached },
  },
})

// A window with a folder: its workspace.json names the folder as a file URI.
const userDir = join(root, 'Code', 'User')
const project = join(root, 'projects', 'example-app')
mkdirSync(project, { recursive: true })
const wsDir = join(userDir, 'workspaceStorage', 'a1b2c3')
mkdirSync(join(wsDir, 'chatSessions'), { recursive: true })
writeFileSync(
  join(wsDir, 'workspace.json'),
  JSON.stringify({ folder: pathToFileURL(project).href }),
)
const log = join(wsDir, 'chatSessions', 'chat-one.jsonl')

const initial = {
  kind: 0,
  v: {
    version: 3,
    sessionId: 'chat-one',
    creationDate: T1,
    responderUsername: 'GitHub Copilot',
    requests: [
      request('req-1', T1, 'copilot/claude-sonnet-4.6', {
        completionTokens: 900,
        result: { metadata: { promptTokens: 12_000, outputTokens: 300 } },
      }),
    ],
    inputState: { inputText: '' },
  },
}

writeFileSync(
  log,
  jl(
    initial,
    // UI state and a streamed response: not counted, never parsed for it.
    { kind: 1, k: ['inputState', 'inputText'], v: 'Example draft' },
    { kind: 2, k: ['requests'], v: [request('req-2', T2, 'copilot/auto')] },
    { kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'Example partial answer' }] },
    { kind: 1, k: ['requests', 1, 'completionTokens'], v: 400 },
    { kind: 1, k: ['requests', 1, 'completionTokens'], v: 750 },
    {
      kind: 1,
      k: ['requests', 1, 'result'],
      v: {
        metadata: {
          promptTokens: 20_000,
          outputTokens: 120,
          resolvedModel: 'gpt-5.3-codex',
          summaries: [summary('round-a', 50_000, 40_000, 800)],
          toolCallRounds: [{ id: 'round-a', thinking: { tokens: 10 } }],
        },
        timings: { totalElapsed: 1000 },
      },
    },
    // A third request, later removed by an edit: it was still sent, so it still counts.
    { kind: 2, k: ['requests'], v: [request('req-3', T3, 'byok-openai/gpt-5.5')] },
    { kind: 2, k: ['requests'], i: 2 },
  ),
)

describe('a Copilot Chat operation log', () => {
  const store = newStore()

  test('replays into one call per request, with the tokens the log wrote', async () => {
    const seen: Array<[string, number | null]> = []
    const n = await ingestCopilot(store, userDir, { onFile: (p, e) => seen.push([p, e]) })
    expect(n).toBe(4)
    expect(seen).toEqual([[log, 4]])
    const ev = byId(store)
    expect([...ev.keys()]).toEqual([
      'vscode-copilot:chat-one:req-1',
      'vscode-copilot:chat-one:req-2',
      'vscode-copilot:chat-one:req-3',
      'vscode-copilot:chat-one:summary:round-a',
    ])
    // VS Code's own completion total wins over Copilot's newest-call figure; the prompt is the newest call's.
    expect(ev.get('vscode-copilot:chat-one:req-1')).toMatchObject({
      ts: T1,
      session: 'chat-one',
      model: 'claude-sonnet-4-6',
      provider: 'github-copilot',
      input: 12_000,
      output: 900,
    })
    // `auto` is the model Copilot picked.
    expect(ev.get('vscode-copilot:chat-one:req-2')).toMatchObject({
      ts: T2,
      model: 'gpt-5.3-codex',
      provider: 'github-copilot',
      input: 20_000,
      output: 750,
    })
    // No count written: a call, never an estimate.
    expect(ev.get('vscode-copilot:chat-one:req-3')).toMatchObject({
      ts: T3,
      model: 'gpt-5.5',
      provider: 'openai',
      input: 0,
      output: 0,
    })
    // The history summary is its own call, its cached prompt kept apart.
    expect(ev.get('vscode-copilot:chat-one:summary:round-a')).toMatchObject({
      ts: T2,
      model: 'claude-sonnet-4-6',
      input: 10_000,
      cache_read: 40_000,
      output: 800,
    })
  })

  test('keeps the folder the window had open, for Cost by project (session-cwds.ts)', () => {
    expect(store.getMeta(cwdKey('chat-one'))).toBe(project)
  })

  test('an unchanged log is skipped; appended ops are read from where the last sweep stopped', async () => {
    const seen: Array<number | null> = []
    expect(await ingestCopilot(store, userDir, { onFile: (_, e) => seen.push(e) })).toBe(0)
    expect(seen).toEqual([null])

    appendFileSync(
      log,
      jl(
        { kind: 2, k: ['requests'], v: [request('req-4', NOW - 60_000, 'copilot/gpt-5.4')] },
        {
          kind: 1,
          k: ['requests', 2, 'result'],
          v: {
            metadata: {
              promptTokens: 30_000,
              outputTokens: 40,
              // Carried on from req-2: written once.
              summaries: [summary('round-a', 50_000, 40_000, 800)],
            },
          },
        },
      ),
    )
    expect(await ingestCopilot(store, userDir)).toBe(1)
    const ev = byId(store)
    expect(ev.size).toBe(5)
    expect(ev.get('vscode-copilot:chat-one:req-4')).toMatchObject({
      model: 'gpt-5.4',
      input: 30_000,
      output: 40,
    })
  })

  test('a log VS Code rewrote as one whole-chat line is read again from the top, counting nothing twice', async () => {
    const before = rows(store)
    writeFileSync(
      log,
      jl({
        kind: 0,
        v: {
          ...initial.v,
          requests: [
            ...initial.v.requests,
            request('req-2', T2, 'copilot/auto', {
              completionTokens: 750,
              result: {
                metadata: {
                  promptTokens: 20_000,
                  outputTokens: 120,
                  resolvedModel: 'gpt-5.3-codex',
                },
              },
            }),
            request('req-4', NOW - 60_000, 'copilot/gpt-5.4', {
              result: { metadata: { promptTokens: 30_000, outputTokens: 40 } },
            }),
          ],
        },
      }),
    )
    expect(await ingestCopilot(store, userDir)).toBe(3)
    expect(rows(store)).toEqual(before)
  })
})

describe('the rest of a VS Code folder', () => {
  test("an empty window's older JSON chat counts, and the sweep names the source", async () => {
    const user = join(root, 'Code - Insiders', 'User')
    const empty = join(user, 'globalStorage', 'emptyWindowChatSessions')
    mkdirSync(empty, { recursive: true })
    writeFileSync(
      join(empty, 'chat-two.json'),
      JSON.stringify({
        version: 3,
        sessionId: 'chat-two',
        requests: [
          request('req-a', T1, 'github.copilot-chat/claude-sonnet-4', {
            result: { metadata: { promptTokens: 5_000, outputTokens: 60 } },
          }),
          request('req-b', T2, 'deepseek/deepseek-v4-pro', { completionTokens: 70 }),
        ],
      }),
    )
    const store = newStore()
    const sum = await ingestForeign(
      store,
      { codex: [], opencode: [], hermes: [], dsh: [], vscodeCopilot: [user] },
      {},
    )
    expect(sum.events['vscode-copilot']).toBe(2)
    expect(rows(store).map((r) => [r.id, r.model, r.provider, r.input, r.output])).toEqual([
      ['vscode-copilot:chat-two:req-a', 'claude-sonnet-4', 'github-copilot', 5_000, 60],
      ['vscode-copilot:chat-two:req-b', 'deepseek-v4-pro', 'deepseek', 0, 70],
    ])
    expect(store.getMeta(cwdKey('chat-two'))).toBeNull()
  })

  test('model ids are spelt as the rest of the ledger spells them', () => {
    expect(copilotModel('copilot/claude-opus-4.6')).toBe('claude-opus-4-6')
    expect(copilotModel('anthropic/KEY1/claude-opus-4-7')).toBe('claude-opus-4-7')
    expect(copilotModel('byok-anthropic/byok-anthropic.claude-opus-4-7')).toBe('claude-opus-4-7')
    expect(copilotModel('copilot/gpt-5.4')).toBe('gpt-5.4')
    expect(copilotModel('copilot/auto')).toBe('auto')
    expect(copilotModel('copilot/auto', 'gpt-5.4-2026-03-05')).toBe('gpt-5.4')
    expect(copilotModel(undefined)).toBe('unknown')
    expect(copilotProvider('copilot/gpt-5.4')).toBe('github-copilot')
    expect(copilotProvider('byok-google/gemini-3-flash-preview')).toBe('google')
    expect(copilotProvider('anthropic/KEY1/claude-opus-4-7')).toBe('anthropic')
    expect(copilotProvider(undefined)).toBe('github-copilot')
  })
})

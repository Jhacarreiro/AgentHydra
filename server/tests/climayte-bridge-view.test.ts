import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { load, notify, workers } from '../src/climayte-core'
import { type CliMayteWorker, leanText, toView } from '../src/climayte-lib'
import {
  type CliMayteWorkerLean,
  climayteBridgeWorker,
  climayteLeanWorker,
  climayteList,
} from '../src/climayte-view'
import { app } from '../src/http-app'
import '../src/routes/climayte'

const NOW = Date.now()
const GROUP = 'bridge-projection-synthetic'
const http = new Hono().route('/', app)
function removeScratch(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    // The child has exited; a delayed Windows SQLite close is cleaned by the preload temp sweep.
    if (code !== 'EBUSY' && code !== 'EPERM') throw error
  }
}
let saved: Array<[string, CliMayteWorker]> = []
beforeEach(() => {
  load()
  saved = [...workers]
  workers.clear()
})
afterEach(() => {
  workers.clear()
  for (const [id, w] of saved) workers.set(id, w)
})

function worker(id: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    group: GROUP,
    title: id,
    cwd: '/synthetic/current',
    pendingCwd: '/synthetic/next',
    prompt: '\nA synthetic task\n' + 'p'.repeat(1000),
    pending: ['A queued follow-up'],
    accounts: ['account-current'],
    accountId: 'account-current',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    status: 'done',
    sessionId: 'session-current',
    sessions: ['session-old'],
    result: 'Synthetic reply',
    results: ['Synthetic reply'],
    reports: [{ at: 1, message: 'An earlier synthetic task', results: ['Earlier reply'] }],
    error: null,
    lastActivity: 'Read synthetic.ts',
    costUsd: 1,
    turns: 1,
    moves: 1,
    retries: 0,
    notBefore: NOW + 1000,
    waitUntil: new Date(NOW + 2000).toISOString(),
    createdAt: NOW - 1000,
    updatedAt: NOW,
    stepAt: NOW - 500,
    stateAt: { key: 'running', at: NOW - 750 },
    saidLine: 'Checking the synthetic result',
    saidAt: NOW - 100,
    kind: 'code',
    chat: true,
    wave: 'wave-example',
    hold: 'wave',
    origin: {
      kind: 'chat',
      sessionId: 'session-parent',
      home: '/synthetic/home',
      transcript: '/synthetic/parent.jsonl',
      how: 'Synthetic origin',
    },
    question: { text: 'Choose an option', options: ['A', 'B'], at: NOW - 50 },
    eta: { minutes: 2, at: NOW - 1000, attempt: 1, tookS: 1, doneAt: NOW },
    verdicts: [
      {
        at: NOW,
        by: 'owner',
        verdict: 'pass',
        note: 'Synthetic note\nLonger context',
        model: 'claude-opus-5-5',
        effort: 'medium',
        units: 100,
      },
    ],
    tokens: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
    attempts: [
      {
        account: { id: 'account-old', num: null, name: 'Default', configDir: '/synthetic/old' },
        pid: null,
        started: true,
        startedAt: NOW - 1000,
        endedAt: NOW - 500,
        outcome: 'quota',
        sessionId: 'session-old',
        log: '/synthetic/a',
        errLog: '/synthetic/a.err',
        notice: null,
        resumed: false,
        model: 'claude-haiku-5-5',
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
        spend: { costUsd: 0.1, turns: 1, reread: null },
      },
      {
        account: {
          id: 'account-current',
          num: 2,
          name: 'Example',
          configDir: '/synthetic/current',
        },
        pid: null,
        started: true,
        startedAt: NOW - 500,
        endedAt: NOW,
        outcome: 'done',
        sessionId: 'session-current',
        log: '/synthetic/b',
        errLog: '/synthetic/b.err',
        notice: 'Synthetic notice',
        resumed: true,
        model: 'claude-opus-5-5',
        tokens: { input: 90, output: 180, cacheRead: 270, cacheWrite: 360 },
        spend: { costUsd: 0.9, turns: 1, reread: null },
        ceiling: { pct: 70, week: false, resetsAt: null },
      },
    ],
    ...over,
  }
}

// Every field in Desk's AhWorker contract, including the optional fields used by transcript and
// chat-manager reads. The old lean response is the oracle; only nested unused fields are removed.
type BridgeContract = ReturnType<typeof climayteBridgeWorker>
function contract(w: CliMayteWorkerLean): BridgeContract {
  return {
    id: w.id,
    group: w.group,
    title: w.title,
    cwd: w.cwd,
    pendingCwd: w.pendingCwd,
    prompt: w.prompt,
    status: w.status,
    sessionId: w.sessionId,
    sessions: w.sessions,
    accountId: w.accountId,
    account: w.account,
    model: w.model,
    effort: w.effort,
    reportedModel: w.reportedModel,
    kind: w.kind,
    chat: w.chat,
    result: w.result,
    error: w.error,
    lastActivity: w.lastActivity,
    doing: w.doing,
    doingSince: w.doingSince,
    doingKind: w.doingKind,
    lastStepAt: w.lastStepAt,
    waitUntil: w.waitUntil,
    notBefore: w.notBefore,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    tokens: w.tokens,
    attempts: w.attempts?.map((a) => ({
      account: a.account,
      outcome: a.outcome,
      tokens: a.tokens,
    })),
    used: w.used && { pct: w.used.pct },
    verdicts: w.verdicts?.map(({ verdict }) => ({ verdict })),
    origin: w.origin,
    wave: w.wave,
    hold: w.hold,
    question: w.question,
    eta: w.eta,
  }
}

describe('CliMayte bridge worker projection', () => {
  test('all AhWorker fields and chat/ancestry consumers match legacy lean across every status and account move', () => {
    const source = (
      ['queued', 'waiting', 'running', 'checking', 'done', 'failed', 'cancelled'] as const
    ).map((status, i) =>
      worker(`bridge-${i}`, {
        status,
        ...(i === 1 ? { accountId: 'account-old' } : {}),
        ...(i === 2 ? { origin: { kind: 'worker', workerId: 'bridge-0' } } : {}),
      }),
    )
    source.push(worker('bridge-manager', { kind: 'manage', wave: 'wave-child' }))
    source.push(
      worker('bridge-child', { status: 'running', origin: undefined, wave: 'wave-child' }),
    )
    source.push(
      worker('bridge-missing-parent', {
        status: 'running',
        origin: { kind: 'worker', workerId: 'not-listed' },
      }),
    )
    source.push(
      worker('bridge-no-attempt', {
        attempts: [],
        tokens: undefined,
        verdicts: undefined,
        question: undefined,
        eta: undefined,
        origin: undefined,
        accountId: null,
      }),
    )
    const repeated = worker('bridge-repeated-account')
    repeated.attempts.push({
      ...repeated.attempts[1]!,
      account: { ...repeated.attempts[1]!.account, name: 'Latest example' },
      model: undefined,
    })
    source.push(repeated)
    const old = source.map((w) => climayteLeanWorker(toView(w, NOW)))
    const next = source.map((w) => climayteBridgeWorker(w, leanText(w).prompt))
    expect(next).toEqual(old.map(contract))
    expect(next.at(-1)).toMatchObject({
      account: '#2 Latest example',
      reportedModel: 'claude-opus-5-5',
    })
    const routine = (w: BridgeContract) => ({
      status: w.status,
      error: w.error,
      result: w.result,
      sessionId: w.sessionId,
    })
    expect(next.map(routine)).toEqual(old.map(routine))
    const transcript = (w: BridgeContract) => ({
      cwd: w.cwd,
      pendingCwd: w.pendingCwd,
      sessionId: w.sessionId,
      sessions: w.sessions,
      accountId: w.accountId,
      attempts: w.attempts?.map((a) => a.account.id),
    })
    expect(next.map(transcript)).toEqual(old.map(transcript))
  })

  test('does not read packed text or unused configuration, spend and verdict-note getters', () => {
    const w = worker('bridge-getters')
    const prompt = leanText(w).prompt
    const forbid = (object: object, key: string) =>
      Object.defineProperty(object, key, {
        enumerable: true,
        get: () => {
          throw new Error(`Unused bridge field read: ${key}`)
        },
      })
    for (const key of [
      'prompt',
      'result',
      'results',
      'reports',
      'pending',
      'desk',
      'check',
      'size',
      'handoffNote',
    ])
      forbid(w, key)
    for (const attempt of w.attempts)
      for (const key of ['spend', 'notice', 'requested', 'left']) forbid(attempt, key)
    for (const verdict of w.verdicts!)
      for (const key of ['note', 'units', 'by']) forbid(verdict, key)
    expect(climayteBridgeWorker(w, prompt)).toMatchObject({
      prompt,
      account: '#2 Example',
      reportedModel: 'claude-opus-5-5',
      result: null,
      verdicts: [{ verdict: 'pass' }],
    })
  })

  test('reduces serialized bytes and intermediate attempt fields on ordinary history without changing mapped rows', () => {
    const source = Array.from({ length: 100 }, (_, i) =>
      worker(`bridge-bytes-${i}`, {
        question: undefined,
        eta: undefined,
        origin: undefined,
        chat: undefined,
        wave: undefined,
        hold: undefined,
      }),
    )
    const old = source.map((w) => climayteLeanWorker(toView(w, NOW)))
    const next = source.map((w) => climayteBridgeWorker(w, leanText(w).prompt))
    expect(next).toEqual(old.map(contract))
    const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x))
    expect(bytes(next)).toBeLessThan(bytes(old) * 0.8)
    console.info(
      `[climayte-bridge] 100 synthetic rows: lean=${bytes(old)} bytes, bridge=${bytes(next)} bytes`,
    )
    expect(Object.keys(next[0]!.attempts[0]!)).toEqual(['account', 'outcome', 'tokens'])
    expect(Object.keys(toView(source[0]!, NOW).attempts[0]!).length).toBeGreaterThan(8)
  })

  test('HTTP bridge uses identical row filtering/order; lean/full stay unchanged and brief/report take precedence', async () => {
    const a = worker('bridge-http-a')
    const b = worker('bridge-http-b', {
      status: 'waiting',
      origin: { kind: 'worker', workerId: a.id },
    })
    workers.set(a.id, a)
    workers.set(b.id, b)
    const read = async (query: string) =>
      (await (
        await http.fetch(new Request(`http://127.0.0.1/api/corch/workers?group=${GROUP}${query}`))
      ).json()) as CliMayteWorkerLean[]
    const lean = await read('&lean=1')
    const bridge = await read('&lean=1&bridge=1')
    expect(bridge).toEqual(JSON.parse(JSON.stringify(lean.map(contract))))
    expect(bridge.map((w) => w.id)).toEqual(lean.map((w) => w.id))
    expect(await read('&lean=1&bridge=1&ids=bridge-http-a')).toEqual([
      bridge.find((w) => w.id === a.id)!,
    ])
    expect(await read('&lean=1&bridge=1&active=1&limit=0')).toEqual([
      bridge.find((w) => w.id === b.id)!,
    ])
    expect(await read('&lean=1&bridge=1&origin=session-parent')).toEqual(bridge)
    expect(await read('&lean=1&bridge=1&session=session-old')).toEqual(bridge)
    expect(await read('&lean=1')).toEqual(lean)
    expect((await read('')).find((w) => w.id === a.id)!.result).toBe('Synthetic reply')
    expect(await read('&bridge=1&brief=1')).toEqual(await read('&brief=1'))
    expect(await read('&bridge=1&report=1')).toEqual(await read('&report=1'))
    expect(JSON.parse(JSON.stringify(climayteList({ group: GROUP, bridge: true })))).toEqual(bridge)
  })

  test('waiting bridge reads retain the projection after the selected worker changes', async () => {
    const w = worker('bridge-wait', { status: 'queued' })
    workers.set(w.id, w)
    const waiting = http.fetch(
      new Request(`http://127.0.0.1/api/corch/workers?group=${GROUP}&lean=1&bridge=1&wait=1`),
    )
    await Bun.sleep(0)
    w.status = 'done'
    notify(w)
    const rows = (await (await waiting).json()) as BridgeContract[]
    expect(rows).toEqual(JSON.parse(JSON.stringify(climayteList({ group: GROUP, bridge: true }))))
    expect('pending' in rows[0]!).toBe(false)
    expect(rows[0]!.used).toEqual({ pct: climayteLeanWorker(toView(w, NOW)).used.pct })
  })

  test('a real cold-history bridge list leaves all packed text accessors packed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'climayte-bridge-cold-'))
    try {
      const done = join(dir, 'corch', 'done')
      mkdirSync(done, { recursive: true })
      mkdirSync(join(dir, 'data'), { recursive: true })
      const w = worker('bridge-cold')
      writeFileSync(join(done, `${w.id}.json`), JSON.stringify(w))
      const core = pathToFileURL(resolve(import.meta.dir, '../src/climayte-core.ts')).href
      const view = pathToFileURL(resolve(import.meta.dir, '../src/climayte-view.ts')).href
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `
        const core = await import(${JSON.stringify(core)})
        await core.preloadDone()
        core.load()
        const view = await import(${JSON.stringify(view)})
        const w = core.workers.get('bridge-cold')
        const packed = () => ['prompt', 'result', 'results', 'reports'].every(k => typeof Object.getOwnPropertyDescriptor(w, k)?.get === 'function')
        const before = packed()
        const rows = view.climayteList({ group: ${JSON.stringify(GROUP)}, lean: true, bridge: true })
        console.log('@@bridge-cold@@' + JSON.stringify({ before, after: packed(), ids: rows.map(w => w.id), prompt: rows[0].prompt }))
      `,
        ],
        {
          cwd: resolve(import.meta.dir, '..'),
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 20_000,
          windowsHide: true,
          env: {
            ...process.env,
            AGENTHYDRA_HOME: dir,
            AGENTHYDRA_DATA_DIR: join(dir, 'data'),
            AGENTHYDRA_DB: join(dir, 'data', 'test.db'),
            AGENTHYDRA_RUN_LOG_DIR: join(dir, 'run-logs'),
          },
        },
      )
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const line = out.split('\n').find((l) => l.startsWith('@@bridge-cold@@'))
      if (code !== 0 || !line)
        throw new Error(`Scratch bridge process failed (${code}): ${err}\n${out}`)
      expect(JSON.parse(line.slice('@@bridge-cold@@'.length))).toEqual({
        before: true,
        after: true,
        ids: [w.id],
        prompt: w.prompt.slice(0, 300),
      })
    } finally {
      removeScratch(dir)
    }
  }, 30_000)
})

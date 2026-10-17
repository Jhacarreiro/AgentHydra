import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load, workers } from '../src/climayte-core'
import { type CliMayteWorker, recentWorkers } from '../src/climayte-lib'
import { climayteList } from '../src/climayte-view'
import { rmRetry } from './rm-retry'

const GROUP = 'pane-projection-synthetic'
const NOW = 1_000_000
// Independent contract oracle: no field declared or consumed by Hydra's worker UI is removed.
const OMIT = [
  'eta',
  'pastEtas',
  'message',
  'origin',
  'trace',
  'sealed',
  'check',
  'desk',
  'handoffNote',
  'requestId',
] as const
let saved: Array<[string, CliMayteWorker]> = []
let clock: { mockRestore(): void }
beforeEach(() => {
  load()
  saved = [...workers]
  workers.clear()
  clock = spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  clock.mockRestore()
  workers.clear()
  for (const [id, w] of saved) workers.set(id, w)
})

function worker(id: string, extra: Partial<CliMayteWorker> = {}): CliMayteWorker {
  const tokens = { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 }
  return {
    id,
    group: GROUP,
    title: `Example ${id}`,
    cwd: '/synthetic/current',
    pendingCwd: '/synthetic/next',
    prompt: 'Example task '.repeat(50),
    pending: ['Example held message'],
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    accounts: ['example-account'],
    accountId: 'example-account',
    status: 'done',
    sessionId: 'example-current-session',
    sessions: ['example-prior-session'],
    attempts: [
      {
        account: {
          id: 'example-account',
          num: 1,
          name: 'Example',
          configDir: '/synthetic/account',
        },
        pid: null,
        started: true,
        startedAt: 1_000,
        endedAt: 2_000,
        outcome: 'done',
        sessionId: 'example-current-session',
        log: '/synthetic/log',
        errLog: '/synthetic/err',
        notice: 'Example notice',
        resumed: false,
        tokens,
        cacheTtl: '5m',
        requested: { model: 'claude-sonnet-5-5', effort: 'medium' },
        model: 'claude-opus-5-5',
        spend: { costUsd: 0.1, turns: 1, reread: tokens },
        ceiling: { pct: 90, week: false, resetsAt: null },
      },
    ],
    result: 'Example report',
    results: ['Example report'],
    reports: [
      { at: 1, message: 'An earlier example message', results: ['Earlier example report'] },
    ],
    error: null,
    lastActivity: 'Example activity',
    costUsd: 0.1,
    tokens,
    turns: 1,
    moves: 0,
    retries: 1,
    notBefore: NOW + 1000,
    waitUntil: '2026-10-17T00:00:00.000Z',
    createdAt: 1,
    updatedAt: 2,
    kind: 'code',
    auto: true,
    role: 'drone',
    priority: 3,
    wave: 'example-wave',
    hold: 'wave',
    stepAt: 3_000,
    saidLine: 'Example narration',
    saidAt: 4_000,
    stateAt: { key: 'waiting', at: 2_500 },
    question: {
      text: 'Example question',
      options: ['A', 'B'],
      context: 'Example context',
      at: 5_000,
    },
    verdicts: [
      {
        at: 2_100,
        verdict: 'fail',
        note: 'Example first line\nExample second line',
        model: 'claude-opus-5-5',
        effort: 'medium',
        units: 100,
        by: 'owner',
        severity: 2,
      },
      {
        at: 2_200,
        verdict: 'pass',
        note: 'Example passing note',
        model: 'claude-opus-5-5',
        effort: 'medium',
        units: 200,
        by: 'orchestrator',
      },
    ],
    eta: { minutes: 5, at: 1_000, attempt: 0, tookS: 1, doneAt: 2_000 },
    pastEtas: [{ minutes: 3, at: 0, attempt: 0, tookS: 2, doneAt: 500 }],
    message: 'Example current message',
    origin: { kind: 'worker', workerId: 'example-parent' },
    trace: { label: 'Example script', sessionId: 'example-trace' },
    sealed: {
      systemPromptFile: '/synthetic/system',
      mcpConfig: '/synthetic/mcp',
      allowedTools: [],
    },
    check: 'echo example',
    desk: { append: 'Example system text', mcpServers: {}, manager: 'example-manager' },
    handoffNote: 'Example handoff',
    requestId: 'example-request',
    ...extra,
  }
}

function withoutRaw<T extends object>(row: T): Omit<T, (typeof OMIT)[number]> {
  const copy = { ...row } as Record<string, unknown>
  for (const key of OMIT) delete copy[key]
  return copy as Omit<T, (typeof OMIT)[number]>
}

function removeScratch(home: string): void {
  const target = resolve(home)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('climayte-pane-'))
    throw new Error('Refusing unexpected pane fixture cleanup')
  rmRetry(target)
}

test('pane JSON is exactly existing lean JSON minus unused raw fields across states and UI fallbacks', () => {
  const rows = (
    ['queued', 'waiting', 'running', 'checking', 'done', 'failed', 'cancelled'] as const
  ).map((status, i) => worker(`pane-${status}`, { status, createdAt: i + 1, updatedAt: i + 2 }))
  rows.push(
    worker('example-parent', { sessionId: 'parent-current-session', role: undefined, chat: true }),
  )
  rows.push(
    worker('pane-empty', {
      attempts: [],
      verdicts: undefined,
      origin: undefined,
      trace: undefined,
    }),
  )
  Object.assign(rows[0]!, { unknownMetadata: { retained: true } })
  for (const w of rows) workers.set(w.id, w)
  const lean = climayteList({ group: GROUP, lean: true })
  const pane = climayteList({ group: GROUP, lean: true, pane: true })
  expect(JSON.stringify(pane)).toBe(JSON.stringify(lean.map(withoutRaw)))
  expect(pane.map((w) => w.id)).toEqual(recentWorkers(rows, undefined).map((w) => w.id))
  const child = pane.find((w) => w.id === 'pane-done')!
  expect(child).toMatchObject({
    pending: ['Example held message'],
    question: { text: 'Example question', options: ['A', 'B'] },
    account: '#1 Example',
    reportedModel: 'claude-opus-5-5',
    priority: 3,
    originWorkerId: 'example-parent',
    originSessionId: 'parent-current-session',
    originLabel: 'Example script',
  })
  expect(child.attempts[0]).toMatchObject({ outcome: 'done', ceiling: true })
  expect(child.verdicts).toHaveLength(2)
  expect(child.verdicts![0]).toMatchObject({ note: 'Example first line', by: 'owner', severity: 2 })
  expect(pane.find((w) => w.id === 'example-parent')!.role).toBe('seat')
  expect(
    (pane.find((w) => w.id === 'pane-queued') as unknown as { unknownMetadata: unknown })
      .unknownMetadata,
  ).toEqual({ retained: true })
  expect(climayteList({ group: GROUP, pane: true })).toEqual(climayteList({ group: GROUP }))
  expect(lean.find((w) => w.id === 'pane-done')!.eta).toEqual(rows[4]!.eta)
})

test('pane reads observe mutations, filters and latest attempt/verdict changes without caching', () => {
  const w = worker('pane-live')
  workers.set(w.id, w)
  const first = climayteList({ id: w.id, lean: true, pane: true })[0]!
  w.status = 'running'
  w.title = 'Updated example title'
  w.pending.push('Second held message')
  w.attempts.push({
    ...w.attempts[0]!,
    outcome: 'running',
    endedAt: null,
    model: 'claude-haiku-5-5',
  })
  w.verdicts![0]!.severity = 1
  w.verdicts![0]!.note = 'Updated note\nHidden continuation'
  const next = climayteList({ id: w.id, lean: true, pane: true })[0]!
  expect(next).toEqual(withoutRaw(climayteList({ id: w.id, lean: true })[0]!))
  expect(next.title).toBe('Updated example title')
  expect(next.attempts).toHaveLength(2)
  expect(next.reportedModel).toBe('claude-haiku-5-5')
  expect(next.verdicts![0]).toMatchObject({ severity: 1, note: 'Updated note' })
  expect(next.ranS).toBeGreaterThan(first.ranS)
  expect(climayteList({ ids: ['missing'], lean: true, pane: true })).toEqual([])
  expect(climayteList({ group: GROUP, lean: true, pane: true, limit: 0 })).toHaveLength(1)
})

test('large pane lists leave unused raw getters unread instead of materializing them to discard', () => {
  let reads = 0
  for (let i = 0; i < 1_000; i++) {
    const w = worker(`pane-cost-${i}`, { createdAt: i, updatedAt: i })
    for (const key of OMIT.filter((key) => key !== 'origin' && key !== 'trace')) {
      const value = w[key]
      Object.defineProperty(w, key, {
        enumerable: true,
        get() {
          reads++
          return value
        },
      })
    }
    workers.set(w.id, w)
  }
  const lean = climayteList({ group: GROUP, lean: true })
  expect(reads).toBe(8_000)
  reads = 0
  const pane = climayteList({ group: GROUP, lean: true, pane: true })
  expect(reads).toBe(0)
  expect(JSON.stringify(pane)).toBe(JSON.stringify(lean.map(withoutRaw)))
})

test('packed pane HTTP/wait reads preserve flag precedence and full detail data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'climayte-pane-'))
  try {
    const done = join(home, 'corch', 'done')
    mkdirSync(done, { recursive: true })
    mkdirSync(join(home, 'data'), { recursive: true })
    const w = worker('pane-packed')
    writeFileSync(join(done, `${w.id}.json`), JSON.stringify(w))
    const url = (file: string) =>
      JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', file)).href)
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
      const { Hono } = await import('hono')
      const core = await import(${url('climayte-core.ts')})
      const view = await import(${url('climayte-view.ts')})
      const { app } = await import(${url('http-app.ts')})
      await core.preloadDone(); core.load()
      await import(${url('routes/climayte.ts')})
      const api = new Hono().route('/', app)
      const assert = (value, text) => { if (!value) throw Error(text) }
      const raw = core.workers.get('pane-packed')
      const isPacked = () => typeof Object.getOwnPropertyDescriptor(raw, 'prompt')?.get === 'function'
      assert(isPacked(), 'Fixture was not packed')
      const descriptors = new Map()
      for (const key of ['prompt', 'result', 'results', 'reports', 'eta', 'pastEtas', 'message', 'sealed', 'check', 'desk', 'handoffNote', 'requestId']) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(raw, key))
        Object.defineProperty(raw, key, { enumerable:true, configurable:true, get() { throw Error('Pane read ' + key) } })
      }
      const direct = view.climayteList({ id: raw.id, lean:true, pane:true })
      const read = async query => {
        const r = await api.fetch(new Request('http://127.0.0.1/api/corch/workers?id=pane-packed&' + query))
        assert(r.status === 200, 'HTTP pane failed'); return await r.json()
      }
      const http = await read('lean=1&pane=1')
      assert(JSON.stringify(http) === JSON.stringify(direct), 'HTTP pane parity changed')
      const active = {...${JSON.stringify(worker('pane-active', { status: 'queued' }))}}
      core.workers.set(active.id, active)
      const wait = api.fetch(new Request('http://127.0.0.1/api/corch/workers?group=${GROUP}&lean=1&pane=1&wait=1'))
      await new Promise(resolve => setTimeout(resolve,0)); core.notify(active)
      const waited = await (await wait).json()
      assert(waited.length === 2 && waited.every(w => !Object.hasOwn(w,'eta') && w.result === null), 'Waiting pane shape changed')
      core.workers.delete(active.id)
      assert(isPacked(), 'Pane unpacked history')
      for (const [key, desc] of descriptors) if (desc) Object.defineProperty(raw,key,desc); else delete raw[key]
      const same = async (query, expected) => assert(JSON.stringify(await read(query)) === JSON.stringify(expected), 'Flag precedence changed: ' + query)
      await same('pane=1', view.climayteList({ id:raw.id }))
      await same('lean=1&pane=0', view.climayteList({ id:raw.id, lean:true }))
      await same('lean=1&pane=1&bridge=1', view.climayteList({ id:raw.id, bridge:true }))
      await same('lean=1&pane=1&brief=1', view.climayteList({ id:raw.id, brief:true }))
      await same('lean=1&pane=1&report=1', view.climayteReports({ id:raw.id }))
      const detailResponse = await api.fetch(new Request('http://127.0.0.1/api/corch/workers/pane-packed?prompt=full&pane=1&lean=1'))
      const detail = await detailResponse.json()
      assert(detailResponse.status === 200 && detail.prompt === raw.prompt && detail.prompt.length > 300, 'Full prompt changed')
      for (const key of ${JSON.stringify(OMIT)}) assert(JSON.stringify(detail[key]) === JSON.stringify(raw[key]), 'Full detail lost ' + key)
      assert(detail.attempts[0].notice === 'Example notice' && detail.results[0] === 'Example report', 'Full attempt/report detail changed')
      console.log(JSON.stringify({ packed:true, waiting:waited.length, detail:true, precedence:true }))
    `,
      ],
      {
        cwd: resolve(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
        windowsHide: true,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, 'roaming'),
          LOCALAPPDATA: join(home, 'local'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CODEX_HOME: join(home, '.codex'),
          HSWARM_HOME: join(home, '.hswarm'),
          AGENTHYDRA_HOME: home,
          AGENTHYDRA_DATA_DIR: join(home, 'data'),
          AGENTHYDRA_DB: join(home, 'data', 'test.db'),
          AGENTHYDRA_RUN_LOG_DIR: join(home, 'logs'),
          AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
          AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
        },
      },
    )
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ packed: true, waiting: 2, detail: true, precedence: true })
  } finally {
    removeScratch(home)
  }
}, 35_000)

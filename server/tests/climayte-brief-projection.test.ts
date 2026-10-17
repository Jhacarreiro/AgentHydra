import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load, workers } from '../src/climayte-core'
import {
  type CliMayteWorker,
  RECAP_HEADER,
  recentWorkers,
  toBrief,
  toView,
} from '../src/climayte-lib'
import { climayteList } from '../src/climayte-view'

const GROUP = 'brief-cold-synthetic'
const NOW = 10_000

function cleanup(dir: string): void {
  const target = resolve(dir)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('climayte-brief-cold-')
  )
    throw new Error('Refusing unexpected scratch cleanup')
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    // The exited scratch process can leave a brief Windows lock; the preload temp sweep removes it.
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
    cwd: '/synthetic',
    prompt: 'Synthetic task '.repeat(400),
    pending: ['Synthetic follow-up'],
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    accounts: null,
    status: 'done',
    sessionId: 'synthetic-session',
    accountId: 'synthetic-account',
    result: null,
    error: null,
    lastActivity: 'Synthetic activity '.repeat(20),
    costUsd: 1.234,
    moves: 2,
    turns: 1,
    retries: 0,
    priority: 1,
    notBefore: null,
    createdAt: 1,
    updatedAt: 2,
    question: { text: 'Synthetic question '.repeat(30), options: ['A', 'B'], at: 1 },
    eta: { minutes: 2, at: 1, attempt: 0, tookS: 15, doneAt: 3 },
    attempts: [
      {
        account: { id: 'synthetic-account', num: 3, name: 'Example' },
        pid: null,
        started: true,
        startedAt: 1,
        endedAt: 2,
        outcome: 'done',
        sessionId: 'synthetic-session',
        log: '/synthetic/attempt',
        errLog: '/synthetic/attempt.err',
        notice: null,
        resumed: false,
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
        spend: { costUsd: 1.234, turns: 1, reread: null },
        left: ['Synthetic background command'],
      },
    ],
    ...over,
  }
}

function examples(): CliMayteWorker[] {
  return [
    worker('brief-empty', { pending: [], costUsd: 0, moves: 0, priority: 0 }),
    worker('brief-legacy', { result: 'Legacy result '.repeat(1000) }),
    worker('brief-empty-results', { result: 'Fallback result', results: [] }),
    worker('brief-current', {
      result: 'Stored aggregate',
      results: ['First current result', 'Second current result'],
    }),
    worker('brief-earlier-recap', {
      results: ['Current reply'],
      reports: [
        {
          at: 1,
          message: 'Earlier synthetic task',
          results: [`${RECAP_HEADER}\nEarlier synthetic proof`],
        },
      ],
    }),
    worker('brief-current-recap', {
      results: [`${RECAP_HEADER}\nCurrent synthetic proof`],
      reports: [{ at: 1, message: 'Earlier task', results: [`${RECAP_HEADER}\nOld proof`] }],
    }),
    worker('brief-reviewed', {
      createdAt: 20,
      updatedAt: 20,
      verdicts: [
        {
          at: 10,
          verdict: 'pass',
          note: 'Synthetic verdict',
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          units: 10,
          by: 'owner',
        },
      ],
    }),
    worker('brief-failed', { status: 'failed', error: 'Synthetic failure', question: undefined }),
    worker('brief-cancelled', { status: 'cancelled', eta: undefined, question: undefined }),
  ].map((w, i) => ({
    ...w,
    createdAt: w.createdAt === 20 ? 20 : i + 1,
    updatedAt: w.updatedAt === 20 ? 20 : i + 2,
  }))
}

test('brief projection preserves exact JSON, including legacy/recap counts, omission, metadata and precedence', () => {
  const source = examples()
  for (const [i, status] of (['queued', 'waiting', 'running', 'checking'] as const).entries())
    source.push(worker(`brief-active-${i}`, { status, waitUntil: '2030-01-01T00:00:00.000Z' }))
  for (const w of source) workers.set(w.id, w)
  const expected = recentWorkers(source, undefined).map((w) => toBrief(toView(w, NOW)))
  const next = climayteList({ group: GROUP, brief: true, all: true })
  expect(JSON.stringify(next)).toBe(JSON.stringify(expected))
  expect(climayteList({ group: GROUP, brief: true, all: true, lean: true, bridge: true })).toEqual(
    next,
  )
  expect(next.find((w) => w.id === 'brief-empty')!.resultChars).toBeUndefined()
  expect(next.find((w) => w.id === 'brief-legacy')!.resultChars).toBe(
    'Legacy result '.repeat(1000).length,
  )
  const recap = next.find((w) => w.id === 'brief-earlier-recap')!
  expect(recap.resultChars).toBe(expected.find((w) => w.id === recap.id)!.resultChars)
  expect(recap).toMatchObject({
    pending: 1,
    moves: 2,
    priority: 1,
    costUsd: 1.23,
    account: '#3 Example',
    leftRunning: 'Synthetic background command',
  })
  expect(recap).not.toHaveProperty('prompt')
  expect(recap).not.toHaveProperty('result')
  expect(recap).not.toHaveProperty('report')
})

test('brief projection keeps malformed legacy text errors rather than inventing empty counts', () => {
  const source = worker('brief-malformed', { results: [null] as unknown as string[] })
  workers.set(source.id, source)
  expect(() => toBrief(toView(source, NOW))).toThrow()
  expect(() => climayteList({ id: source.id, brief: true })).toThrow()
})

test('direct, HTTP and waiting brief reads preserve packed text while retaining selection/order and exact counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'climayte-brief-cold-'))
  try {
    const done = join(dir, 'corch', 'done')
    mkdirSync(done, { recursive: true })
    mkdirSync(join(dir, 'data'), { recursive: true })
    const fixtures = examples()
    for (const w of fixtures) writeFileSync(join(done, `${w.id}.json`), JSON.stringify(w))
    const fixtureFile = join(dir, 'fixtures.json')
    writeFileSync(fixtureFile, JSON.stringify(fixtures))
    const url = (file: string) =>
      JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', file)).href)
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
      import assert from 'node:assert/strict'
      import { readFileSync } from 'node:fs'
      const core = await import(${url('climayte-core.ts')})
      const lib = await import(${url('climayte-lib.ts')})
      const view = await import(${url('climayte-view.ts')})
      await core.preloadDone()
      core.load()
      Date.now = () => ${NOW}
      const fixtures = JSON.parse(readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'))
      const group = ${JSON.stringify(GROUP)}
      let textReads = 0
      const cold = [...core.workers.values()].filter(w => w.group === group)
      for (const w of cold) for (const key of lib.WORKER_TEXT_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(w, key)
        if (!descriptor) continue
        assert.equal(typeof descriptor.get, 'function', 'Fixture must start packed')
        Object.defineProperty(w, key, { ...descriptor, get() { textReads++; return descriptor.get.call(this) } })
      }
      const packed = () => cold.every(w => lib.WORKER_TEXT_FIELDS.every(key => !Object.hasOwn(w, key) || typeof Object.getOwnPropertyDescriptor(w, key).get === 'function'))
      const expected = filter => lib.recentWorkers(fixtures.filter(w => view.matches(w, filter)), filter.limit)
        .filter(w => filter.all || filter.id || filter.ids?.length || lib.isLive(w) || !lib.verdictCoversNewestWork(w))
        .map(w => lib.toBrief(lib.toView(w, ${NOW})))
      const filters = [
        { group, brief: true }, { group, brief: true, all: true },
        { group, brief: true, limit: 1 }, { group, brief: true, limit: 0 },
        { group, brief: true, id: 'brief-reviewed' },
        { group, brief: true, ids: ['brief-reviewed', 'brief-legacy'] },
        { group, brief: true, sessions: ['synthetic-session'] },
      ]
      for (const filter of filters) assert.equal(JSON.stringify(view.climayteList(filter)), JSON.stringify(expected(filter)))
      assert.equal(packed(), true)
      assert.equal(textReads, 0, 'Briefs must not read discarded cold text')
      const { Hono } = await import('hono')
      const { app } = await import(${url('http-app.ts')})
      await import(${url('routes/climayte.ts')})
      const api = new Hono().route('/', app)
      for (const [query, filter] of [
        ['&brief=1', filters[0]], ['&brief=1&all=1', filters[1]],
        ['&brief=1&lean=1&bridge=1&all=1', filters[1]],
        ['&brief=1&limit=1', filters[2]], ['&brief=1&ids=brief-reviewed,brief-legacy', filters[5]],
      ]) {
        const response = await api.fetch(new Request('http://127.0.0.1/api/corch/workers?group=' + group + query))
        assert.equal(response.status, 200)
        assert.equal(JSON.stringify(await response.json()), JSON.stringify(expected(filter)))
      }
      const active = { ...${JSON.stringify(worker('brief-wait-active'))}, status: 'queued' }
      core.workers.set(active.id, active)
      const waiting = api.fetch(new Request('http://127.0.0.1/api/corch/workers?group=' + group + '&brief=1&all=1&wait=1'))
      await new Promise(resolve => setTimeout(resolve, 0))
      active.status = 'done'
      core.notify(active)
      const waited = await (await waiting).json()
      assert.ok(waited.some(w => w.id === active.id && w.status === 'done'))
      const old = waited.filter(w => w.id !== active.id)
      assert.equal(JSON.stringify(old), JSON.stringify(expected(filters[1])))
      assert.equal(packed(), true)
      assert.equal(textReads, 0)
      console.log('@@brief-cold@@' + JSON.stringify({ rows: cold.length, directCases: filters.length, textReads, packed: packed() }))
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
    const line = out.split('\n').find((value) => value.startsWith('@@brief-cold@@'))
    if (code !== 0 || !line)
      throw new Error(`Scratch brief process failed (${code}): ${err}\n${out}`)
    expect(JSON.parse(line.slice('@@brief-cold@@'.length))).toEqual({
      rows: fixtures.length,
      directCases: 7,
      textReads: 0,
      packed: true,
    })
  } finally {
    cleanup(dir)
  }
}, 30_000)

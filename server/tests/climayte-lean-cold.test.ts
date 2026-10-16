// Lean lists must not decompress the four long fields they never send to a list row.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type CliMayteWorker, leanText, RECAP_HEADER, toView } from '../src/climayte-lib'
import { climayteLeanWorker } from '../src/climayte-view'

const GROUP = 'lean-cold-synthetic'
const NOW = 10_000

function worker(id: string, extra: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    group: GROUP,
    title: id,
    cwd: '/synthetic',
    prompt: 'Example task '.repeat(100),
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    status: 'done',
    sessionId: null,
    accountId: null,
    attempts: [],
    result: null,
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  }
}

test('lean preview exactly matches full-view recap and legacy result counts', () => {
  const cases: Partial<CliMayteWorker>[] = [
    {},
    { result: 'Legacy report' },
    { result: 'Legacy fallback', results: [] },
    { result: 'stored aggregate', results: ['first', 'second'] },
    {
      results: ['current reply'],
      reports: [{ at: 1, message: 'earlier message', results: [`${RECAP_HEADER}\nEarlier proof`] }],
    },
    {
      results: [`${RECAP_HEADER}\nCurrent proof`],
      reports: [{ at: 1, message: 'earlier message', results: [`${RECAP_HEADER}\nEarlier proof`] }],
    },
    {
      reports: [
        { at: 1, message: 'oldest', results: [`${RECAP_HEADER}\nOld proof`] },
        { at: 2, message: 'newest', results: [`${RECAP_HEADER}\nNew proof`, 'follow-up'] },
      ],
    },
  ]
  for (const [index, extra] of cases.entries()) {
    const w = worker(`w-preview-${index}`, extra)
    const expected = climayteLeanWorker(toView(w, NOW))
    expect(leanText(w)).toEqual({ prompt: expected.prompt, resultChars: expected.resultChars })
  }
})

test('long prompt preview preserves UTF16 truncation including a lone surrogate', () => {
  const prompt = `${'x'.repeat(299)}\uD83C\uDF0E${'y'.repeat(1000)}`
  const preview = leanText(worker('w-preview-unicode', { prompt }))
  expect(preview.prompt).toBe(prompt.slice(0, 300))
  expect(preview.prompt).toHaveLength(300)
  expect(preview.prompt.charCodeAt(299)).toBe(0xd83c)
})

test('projected common view never reads any of the four cold text getters', () => {
  const w = worker('w-projected', {
    result: 'stored result',
    results: ['current'],
    reports: [{ at: 1, message: 'earlier', results: [`${RECAP_HEADER}\nEarlier proof`] }],
  })
  const preview = leanText(w)
  const full = toView(w, NOW)
  const { results: _results, reports: _reports, ...expected } = full
  expected.result = null
  for (const key of ['prompt', 'result', 'results', 'reports']) {
    Object.defineProperty(w, key, {
      get: () => {
        throw new Error(`The lean view read ${key}`)
      },
      enumerable: true,
      configurable: true,
    })
  }
  expect(JSON.stringify(toView(w, NOW, undefined, preview))).toBe(JSON.stringify(expected))
})

const scratch = mkdtempSync(join(tmpdir(), 'climayte-lean-cold-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

test('packed history stays packed through direct, HTTP and waiting lean lists; writes refresh previews', async () => {
  const home = join(scratch, 'home')
  const done = join(home, 'corch', 'done')
  mkdirSync(done, { recursive: true })
  mkdirSync(join(home, 'data'), { recursive: true })
  const fixtures = [
    worker('w-packed-legacy', { result: 'Legacy result' }),
    worker('w-packed-current', { createdAt: 2, updatedAt: 3, results: ['first', 'second'] }),
    worker('w-packed-recap', {
      createdAt: 3,
      updatedAt: 4,
      results: ['current'],
      reports: [{ at: 1, message: 'prior message', results: [`${RECAP_HEADER}\nEarlier proof`] }],
    }),
  ]
  for (const w of fixtures) writeFileSync(join(done, `${w.id}.json`), JSON.stringify(w))
  const missingPrompt = {
    ...worker('w-packed-missing-prompt'),
    group: 'malformed-cold',
  } as Partial<CliMayteWorker>
  delete missingPrompt.prompt
  const malformedResults = {
    ...worker('w-packed-malformed-results'),
    group: 'malformed-cold',
    results: [null],
  }
  for (const w of [missingPrompt, malformedResults])
    writeFileSync(join(done, `${w.id}.json`), JSON.stringify(w))
  const core = pathToFileURL(resolve(import.meta.dir, '../src/climayte-core.ts')).href
  const lib = pathToFileURL(resolve(import.meta.dir, '../src/climayte-lib.ts')).href
  const view = pathToFileURL(resolve(import.meta.dir, '../src/climayte-view.ts')).href
  const httpApp = pathToFileURL(resolve(import.meta.dir, '../src/http-app.ts')).href
  const routes = pathToFileURL(resolve(import.meta.dir, '../src/routes/climayte.ts')).href
  const script = `
    const core = await import(${JSON.stringify(core)})
    const lib = await import(${JSON.stringify(lib)})
    const view = await import(${JSON.stringify(view)})
    await core.preloadDone()
    core.load()
    const group = ${JSON.stringify(GROUP)}
    const all = () => [...core.workers.values()].filter(w => w.group === group)
    const packed = () => all().every(w => typeof Object.getOwnPropertyDescriptor(w, 'prompt')?.get === 'function')
    const loadedPacked = packed()
    const malformed = ['w-packed-missing-prompt', 'w-packed-malformed-results'].map(id => core.workers.get(id))
    const malformedRetained = malformed.every(w => w && w.status === 'done' && Array.isArray(w.attempts))
    const malformedPacked = malformed.every(w => typeof Object.getOwnPropertyDescriptor(w, 'result')?.get === 'function')
    const malformedReadErrors = malformed.every(w => { try { core.leanTextOf(w); return false } catch { return true } })
    const malformedUnchanged = !Object.hasOwn(malformed[0], 'prompt') && malformed[1].results.length === 1 && malformed[1].results[0] === null
    const direct = view.climayteList({ group, lean: true })
    const afterDirect = packed()
    const full = view.climayteList({ group })
    const expected = full.map(view.climayteLeanWorker)
    const sameJSON = JSON.stringify(direct) === JSON.stringify(expected)
    const briefUnchanged = JSON.stringify(view.climayteList({ group, brief: true })) === JSON.stringify(full.map(lib.toBrief))
    const reports = view.climayteReports({ group, lean: true })
    const reportsUnchanged = JSON.stringify(reports) === JSON.stringify(full.map(v => lib.toReport(v)))
    core.packColdWorkers(Date.now() + 3_600_000)
    const repacked = packed()
    const malformedRepacked = malformed.every(w => typeof Object.getOwnPropertyDescriptor(w, 'result')?.get === 'function')
    const { Hono } = await import('hono')
    const { app } = await import(${JSON.stringify(httpApp)})
    await import(${JSON.stringify(routes)})
    const api = new Hono().route('/', app)
    const response = await api.fetch(new Request('http://127.0.0.1/api/corch/workers?group=' + group + '&lean=1'))
    const httpRows = await response.json()
    const httpSame = JSON.stringify(httpRows) === JSON.stringify(expected)
    const afterHTTP = packed()
    const active = { ...${JSON.stringify(worker('w-lean-active'))}, status: 'queued' }
    core.workers.set(active.id, active)
    const pending = api.fetch(new Request('http://127.0.0.1/api/corch/workers?group=' + group + '&lean=1&wait=1'))
    await new Promise(resolve => setTimeout(resolve, 0))
    core.notify(active)
    const waited = await (await pending).json()
    core.workers.delete(active.id)
    const afterWait = packed()
    const waitHasCounts = waited.length === 4 && waited.every(w => typeof w.resultChars === 'number' && w.result === null && w.results === undefined && w.reports === undefined)
    const changed = core.workers.get('w-packed-legacy')
    changed.results = ['renewed']
    changed.prompt = 'Changed task'
    const preview = core.leanTextOf(changed)
    const setterUnpacked = typeof Object.getOwnPropertyDescriptor(changed, 'prompt')?.get !== 'function'
    console.log('@@lean-cold@@' + JSON.stringify({ loadedPacked, malformedRetained, malformedPacked, malformedReadErrors, malformedUnchanged, afterDirect, sameJSON, briefUnchanged, reportsUnchanged, repacked, malformedRepacked, httpSame, afterHTTP, afterWait, waitHasCounts, setterUnpacked, preview }))
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 50_000,
    windowsHide: true,
    env: {
      ...process.env,
      AGENTHYDRA_HOME: home,
      AGENTHYDRA_DATA_DIR: join(home, 'data'),
      AGENTHYDRA_DB: join(home, 'data', 'test.db'),
      AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const marker = '@@lean-cold@@'
  const line = out.split('\n').find((value) => value.startsWith(marker))
  if (code !== 0 || !line) throw new Error(`The scratch process failed (${code}): ${err}\n${out}`)
  const { preview, ...checks } = JSON.parse(line.slice(marker.length))
  expect(Object.values(checks)).toEqual(Array(Object.keys(checks).length).fill(true))
  expect(preview).toEqual({ prompt: 'Changed task', resultChars: 7 })
}, 60_000)

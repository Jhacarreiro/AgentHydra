import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = (name: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', name)).href)

async function child<T>(body: string): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'ah-climayte-fs-quota-'))
  mkdirSync(join(home, 'data'))
  try {
    const program = `
      import { spyOn } from 'bun:test'
      import * as fs from 'node:fs'
      import * as fsp from 'node:fs/promises'
      import { join } from 'node:path'
      const home = ${JSON.stringify(home)}
      const core = await import(${source('climayte-core.ts')})
      const effort = await import(${source('climayte-effort.ts')})
      const registry = await import(${source('live-registry.ts')})
      const { fsSlot } = await import(${source('core/fs-slots.ts')})
      const done = join(home, 'corch', 'done')
      fs.mkdirSync(done, { recursive: true })
      const line = text => JSON.stringify({ type: 'assistant', message: {
        role: 'assistant', content: [{ type: 'text', text }]
      } }) + '\\n'
      const log = name => {
        const path = join(home, name + '.jsonl')
        fs.writeFileSync(path, line(name))
        return path
      }
      let active = 0, peak = 0
      const counts = {}, closed = []
      const faults = { stat: null, open: null, read: null, close: null }
      async function io(kind, path, operation) {
        counts[kind] = (counts[kind] ?? 0) + 1
        active++; peak = Math.max(peak, active)
        try {
          await Bun.sleep(1)
          if (faults[kind] === String(path) && kind !== 'close')
            throw new Error('Synthetic ' + kind + ' failure')
          const value = await operation()
          if (faults[kind] === String(path)) throw new Error('Synthetic close failure')
          return value
        } finally { active-- }
      }
      const original = { stat: fsp.stat, readdir: fsp.readdir,
        readFile: fsp.readFile, open: fsp.open }
      for (const kind of ['stat', 'readdir', 'readFile'])
        spyOn(fsp, kind).mockImplementation((path, ...args) =>
          io(kind, path, () => original[kind](path, ...args)))
      spyOn(fsp, 'open').mockImplementation((path, ...args) => io('open', path, async () => {
        const file = await original.open(path, ...args)
        return {
          read: (...args) => io('read', path, () => file.read(...args)),
          close: () => io('close', path, async () => {
            try { return await file.close() } finally { closed.push(String(path)) }
          })
        }
      }))
      async function occupy() {
        const gate = Promise.withResolvers()
        let entered = 0
        const holds = Array.from({ length: 8 }, () => fsSlot(async () => {
          entered++; await gate.promise
        }))
        while (entered !== 8) await Bun.sleep(0)
        return { release: () => gate.resolve(), holds }
      }
      const assert = (value, message) => { if (!value) throw new Error(message) }
      ${body}
    `
    const process = Bun.spawn([globalThis.process.execPath, '-e', program], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...globalThis.process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, '.codex'),
        HSWARM_HOME: join(home, '.hswarm'),
        AGENTHYDRA_HOME: home,
        AGENTHYDRA_DATA_DIR: join(home, 'data'),
        AGENTHYDRA_DB: join(home, 'data', 'test.db'),
        AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
        AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
        AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 25_000,
    })
    const [out, err, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (code !== 0) throw new Error(`Owned fixture failed: ${err || out}`)
    return JSON.parse(out.trim().split('\n').at(-1)!) as T
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('effort history, preload, registrations and running logs all wait for the same eight slots', async () => {
  const result = await child<{
    before: number
    peak: number
    active: number
    counts: Record<string, number>
    closed: number
  }>(`
    for (let i = 0; i < 70; i++) fs.writeFileSync(join(done, 'w-' + i + '.json'),
      JSON.stringify({ id: 'w-' + i, status: 'done', result: null, results: [],
        origin: { kind: 'chat', sessionId: 'example-origin' },
        attempts: [{ sessionId: 'example-session-' + i, requested: { effort: 'medium' } }] }))
    const homes = Array.from({ length: 16 }, (_, i) => {
      const path = join(home, 'registry-' + i)
      fs.mkdirSync(join(path, 'sessions'), { recursive: true })
      fs.writeFileSync(join(path, 'sessions', 'example.json'),
        JSON.stringify({ pid: 123456, sessionId: 'example-registry-' + i }))
      return path
    })
    const logs = Array.from({ length: 32 }, (_, i) => ({ path: log('log-' + i), r: core.freshRead() }))
    const occupied = await occupy()
    const work = Promise.all([
      effort.climayteEffortReady(), core.preloadDone(),
      ...homes.map(path => registry.readRegistrationsAsync(path)),
      ...logs.map(({ path, r }) => core.readIntoAsync(path, r))
    ])
    await Bun.sleep(10)
    const before = Object.values(counts).reduce((sum, n) => sum + n, 0)
    occupied.release()
    const results = await work
    await Promise.all(occupied.holds)
    assert(effort.climayteEffortBySession().size === 70, 'Missing effort history')
    assert(effort.climayteTasksBySession().get('example-origin') === 70, 'Missing origin counts')
    assert(results.slice(2, 18).every(rows => rows.length === 1), 'Missing registrations')
    assert(logs.every(({ r }) => r.events.length === 1), 'Missing running log events')
    console.log(JSON.stringify({ before, peak, active, counts, closed: closed.length }))
  `)
  expect(result.before).toBe(0)
  expect(result.peak).toBe(8)
  expect(result.active).toBe(0)
  expect(result.closed).toBe(32)
  expect(result.counts).toMatchObject({ stat: 102, open: 32, read: 32, close: 32 })
  expect(result.counts.readdir).toBe(18)
  expect(result.counts.readFile).toBe(156)
}, 30_000)

test('failed log opens, reads and closes release their slots and retain guaranteed cleanup', async () => {
  const result = await child<{
    peak: number
    active: number
    closeFailures: number
    recovered: number
  }>(`
    let closeFailures = 0
    for (const kind of ['open', 'read', 'close']) {
      const path = log('fault-' + kind)
      faults[kind] = path
      const before = closed.length
      const r = core.freshRead()
      let rejected = false
      try { await core.readIntoAsync(path, r) } catch { rejected = true }
      assert(rejected, 'Expected injected failure: ' + kind)
      assert(r.offset === 0 && r.events.length === 0, 'A failed read advanced the cursor')
      assert(closed.length - before === (kind === 'open' ? 0 : 1), 'Incorrect file cleanup')
      if (kind === 'close') closeFailures++
      faults[kind] = null
      await core.readIntoAsync(path, r)
      assert(r.events.length === 1, 'Failed operation leaked quota or broke retry')
    }
    const occupied = await occupy()
    let ran = 0
    const recovery = Array.from({ length: 24 }, () => fsSlot(async () => { ran++ }))
    await Bun.sleep(5)
    assert(ran === 0, 'Fixture did not occupy the complete quota')
    occupied.release()
    await Promise.all([...occupied.holds, ...recovery])
    console.log(JSON.stringify({ peak, active, closeFailures, recovered: ran }))
  `)
  expect(result.active).toBe(0)
  expect(result.closeFailures).toBe(1)
  expect(result.recovered).toBe(24)
  expect(result.peak).toBeLessThanOrEqual(8)
}, 30_000)

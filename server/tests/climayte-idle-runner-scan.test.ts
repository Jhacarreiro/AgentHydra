import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = (name: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', name)).href)

function cleanup(home: string): void {
  const target = resolve(home)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('ah-idle-runner-')
  )
    throw new Error('Refusing unexpected scratch cleanup')
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'EBUSY' && code !== 'EPERM') throw error
  }
}

const windowsTest = process.platform === 'win32' ? test : test.skip

windowsTest(
  'idle runner identity scans skip settled attempt getters until an actual late-start mark exists',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'ah-idle-runner-'))
    const script = `
    import assert from 'node:assert/strict'
    import { dirname, join } from 'node:path'
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
    import { spyOn } from 'bun:test'
    const core = await import(${moduleUrl('climayte-core.ts')})
    const stops = await import(${moduleUrl('climayte-stops.ts')})
    const processes = await import(${moduleUrl('core/process.ts')})
    const native = await import(${moduleUrl('core/win-process-table.ts')})
    core.load()
    assert.equal(core.workers.size, 0, 'isolated scratch state starts empty')
    assert.ok(core.ROOT.startsWith(process.env.AGENTHYDRA_HOME), 'only owned scratch paths')
    // Nothing is stopped: on the empty scratch map this only verifies that no late mark exists.
    stops.killLateStarts()
    const originalNow = Date.now, ids = [], spies = []
    let clock = 1_000_000, runnerReads = 0, historicalReads = 0, lastReads = 0
    let markedAttempt, markedRunner
    try {
      Date.now = () => clock
      spies.push(spyOn(processes, 'isPidAlive').mockImplementation(() => {
        throw new Error('The fixture must not query real process identities')
      }))
      spies.push(spyOn(native, 'nativeCommandLines').mockImplementation(() => {
        throw new Error('The fixture must not query native command lines')
      }))
      spies.push(spyOn(processes, 'spawnCaptured').mockImplementation(() => {
        throw new Error('The fixture must not start a process query')
      }))
      spies.push(spyOn(processes, 'killProcessTreesAsync').mockImplementation(async (pids) => {
        assert.deepEqual(pids, [], 'no actual PID can be killed')
      }))
      // This test owns scan/settlement ordering, not thousands of synthetic store writes.
      spies.push(spyOn(core, 'changed').mockImplementation(() => {}))
      const count = 20_000
      for (let i = 0; i < count; i++) {
        const id = 'synthetic-idle-' + i
        const attempts = [0, 1].map(index => {
          const log = join(core.ROOT, 'synthetic', id + '-' + index + '.jsonl')
          const runner = { pid: null, pidFile: log + '.pid', exitFile: log + '.exit', launchedAt: clock }
          const attempt = { log, errLog: log + '.err', pid: null, outcome: 'done', endedAt: clock }
          Object.defineProperty(attempt, 'runner', { enumerable: true, get() {
            runnerReads++
            if (index === 0) historicalReads++
            else lastReads++
            return runner
          } })
          if (i === 0 && index === 0) { markedAttempt = attempt; markedRunner = runner }
          return attempt
        })
        core.workers.set(id, { id, status: 'done', attempts })
        ids.push(id)
      }
      stops.checkRunners()
      assert.equal(runnerReads, 0, 'settled history does not touch attempt runner payloads')
      // A missing owned spec and null PID take the real pending-start path, without any runner launch.
      stops.killAttempts([markedAttempt])
      await stops.killsLanded()
      assert.equal(markedRunner.killOnStart, true)
      runnerReads = historicalReads = lastReads = 0
      clock += 5_001 // The real five-second identity-query cadence remains unchanged.
      stops.checkRunners()
      assert.ok(historicalReads >= count, 'a historical mark restores the full attempt scan')
      assert.ok(lastReads >= count, 'the pending scan still includes every last attempt')
      for (const query of spies.slice(0, 3))
        assert.equal(query.mock.calls.length, 0, 'no process identity or spawn query was attempted')
      assert.equal(spies[3].mock.calls.length, 1, 'only the verified empty kill batch was requested')
      mkdirSync(dirname(markedRunner.exitFile), { recursive: true })
      writeFileSync(markedRunner.exitFile, JSON.stringify({ code: 0 }))
      let settlements = 0
      stops.killLateStarts((_worker, attempt) => {
        assert.equal(attempt, markedAttempt)
        assert.equal(existsSync(markedRunner.exitFile), true,
          'delivery settlement sees the verified exit receipt before cleanup removes it')
        settlements++
      })
      assert.equal(settlements, 1)
      assert.equal(markedRunner.killOnStart, undefined)
      assert.equal(existsSync(markedRunner.exitFile), false)
      console.log(JSON.stringify({ idleRunnerReads: 0, pendingRunnerReads: runnerReads,
        historicalReads, lastReads, workers: count }))
    } finally {
      Date.now = originalNow
      for (const spy of spies) spy.mockRestore()
      for (const id of ids) core.workers.delete(id)
      // Only the isolated owned fixtures were removed; no shared test worker map is cleared.
      stops.killLateStarts()
      await stops.killsLanded()
    }
  `
    try {
      const child = Bun.spawn([process.execPath, '-e', script], {
        cwd: resolve(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        timeout: 10_000,
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
      if (code !== 0)
        throw new Error('Scratch runner scan failed (' + code + '): ' + err + '\n' + out)
      const receipt = JSON.parse(out.trim()) as {
        idleRunnerReads: number
        pendingRunnerReads: number
        workers: number
      }
      expect(receipt.idleRunnerReads).toBe(0)
      expect(receipt.workers).toBe(20_000)
      expect(receipt.pendingRunnerReads).toBeGreaterThanOrEqual(40_000)
    } finally {
      cleanup(home)
    }
  },
  15_000,
)

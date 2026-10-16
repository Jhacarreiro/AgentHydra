import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = (path: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', path)).href)

async function scratchAdapter(script: string): Promise<void> {
  // An isolated module graph keeps updater mocks away from auto-update and the shared-engine tests.
  // Every engine/process/GitHub operation is synthetic; this never invokes git or a real updater.
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    timeout: 20_000,
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Scratch updater adapter failed (${code}): ${err}\n${out}`)
  expect(out.trim()).toBe('updater-adapter-ok')
}

test('source operations serialize whole fetch/pull/install/build flows, preserve fresh queued checks and progress order, and recover after errors', async () => {
  await scratchAdapter(`
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve } }
    const fetchGate = gate(), pullGate = gate(), buildGate = gate()
    const events = []
    let head = 1, checks = 0, applies = 0, progress = 0, firstFetch = true
    let checkFailure = null, applyFailure = null
    const syncCheckError = new Error('Synthetic synchronous check refusal')
    const rejectedCheckError = new Error('Synthetic rejected check refusal')
    const syncApplyError = new Error('Synthetic synchronous apply refusal')
    const rejectedApplyError = new Error('Synthetic rejected apply refusal')
    mock.module(${moduleUrl('config.ts')}, () => ({ APP_ROOT: '/synthetic/updater', IS_RELEASE: false, SERVICE_NAME: 'synthetic' }))
    mock.module(${moduleUrl('core/process.ts')}, () => ({ spawnCaptured: async (args) => {
      const command = args.join(' ')
      events.push('command:start:' + command)
      if (command === 'git fetch' && firstFetch) { firstFetch = false; await fetchGate.promise }
      if (command === 'git pull') await pullGate.promise
      if (command === 'bun run build') await buildGate.promise
      events.push('command:end:' + command)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    } }))
    mock.module(${moduleUrl('github-updater.ts')}, () => ({
      checkForUpdate: () => { throw new Error('Source used release check') },
      applyUpdate: () => { throw new Error('Source used release apply') },
    }))
    mock.module(${moduleUrl('update-progress.ts')}, () => ({
      beginUpdateProgress: () => events.push('progress:begin:' + (++progress)),
      setUpdatePhase: (phase) => events.push('progress:phase:' + phase),
      finishUpdateProgress: (ok, message) => events.push('progress:finish:' + ok + ':' + message),
    }))
    mock.module(${moduleUrl('updater-engine.mjs')}, () => ({ createUpdater: (config) => {
      const run = args => config.run(args, { cwd: '/synthetic/updater', env: {}, timeoutMs: 1000 })
      const check = () => {
        const number = ++checks
        events.push('check:start:' + number)
        const failure = checkFailure; checkFailure = null
        if (failure === 'sync') throw syncCheckError
        if (failure === 'reject') return Promise.reject(rejectedCheckError)
        return (async () => {
          await run(['git', 'fetch'])
          events.push('check:end:' + number)
          return { ok: true, head, check: number, updateAvailable: true }
        })()
      }
      return {
        checkForUpdate: check,
        applyUpdate: () => {
          const number = ++applies
          events.push('apply:start:' + number)
          const failure = applyFailure; applyFailure = null
          if (failure === 'sync') throw syncApplyError
          if (failure === 'reject') return Promise.reject(rejectedApplyError)
          if (failure === 'structured') return Promise.resolve({ ok: false, message: 'Synthetic structured failure' })
          return (async () => {
            // The real engine calls its PRIVATE check, never re-enters the public adapter queue.
            await check()
            await run(['git', 'pull'])
            await run(['bun', 'install'])
            await run(['bun', 'run', 'build'])
            head++
            events.push('apply:end:' + number)
            return { ok: true, message: 'applied-' + number, head }
          })()
        },
      }
    } }))
    const updater = await import(${moduleUrl('updater.ts')})
    const until = async (predicate) => {
      for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve()
      assert.ok(predicate(), 'Synthetic operation never reached its gate: ' + events.join(','))
    }
    const before = updater.checkForUpdate()
    const first = updater.applyUpdate()
    const after = updater.checkForUpdate({ fresh: true })
    const second = updater.applyUpdate()
    await until(() => events.includes('command:start:git fetch'))
    assert.equal(checks, 1)
    assert.equal(applies, 0)
    assert.equal(progress, 0, 'A queued apply must not publish progress yet')
    fetchGate.resolve()
    assert.equal((await before).head, 1)
    await until(() => events.includes('command:start:git pull'))
    assert.equal(checks, 2, 'Only the first apply private check may enter')
    assert.equal(applies, 1)
    assert.equal(progress, 1)
    pullGate.resolve()
    await until(() => events.includes('command:start:bun run build'))
    assert.equal(checks, 2, 'No public fetch may interleave with rebuild')
    assert.equal(applies, 1, 'The second apply must wait for the entire first operation')
    buildGate.resolve()
    const [firstResult, afterResult, secondResult] = await Promise.all([first, after, second])
    assert.equal(firstResult.head, 2)
    assert.equal(afterResult.head, 2, 'A queued check must read the newly applied state')
    assert.equal(secondResult.head, 3)
    const position = value => events.indexOf(value)
    assert.ok(position('check:end:1') < position('progress:begin:1'))
    assert.ok(position('progress:begin:1') < position('apply:start:1'))
    assert.ok(position('apply:end:1') < position('progress:finish:true:applied-1'))
    assert.ok(position('progress:finish:true:applied-1') < position('check:start:3'))
    assert.ok(position('check:end:3') < position('progress:begin:2'))
    assert.ok(position('progress:begin:2') < position('apply:start:2'))
    const count = checks
    const fresh = await Promise.all([updater.checkForUpdate(), updater.checkForUpdate()])
    assert.equal(checks, count + 2, 'Queued checks must never coalesce or reuse a previous result')
    assert.equal(fresh[0].check + 1, fresh[1].check)
    for (const [mode, error] of [['sync', syncCheckError], ['reject', rejectedCheckError]]) {
      checkFailure = mode
      const failed = updater.checkForUpdate().then(() => null, e => e)
      const recovered = updater.checkForUpdate()
      assert.equal(await failed, error, 'The caller keeps the exact error')
      assert.equal((await recovered).ok, true)
    }
    for (const [mode, error] of [['sync', syncApplyError], ['reject', rejectedApplyError]]) {
      applyFailure = mode
      const failed = updater.applyUpdate().then(() => null, e => e)
      const recovered = updater.checkForUpdate()
      assert.equal(await failed, error)
      assert.equal((await recovered).ok, true)
      assert.ok(events.includes('progress:finish:false:' + error.message))
    }
    applyFailure = 'structured'
    assert.deepEqual(await updater.applyUpdate(), { ok: false, message: 'Synthetic structured failure' })
    assert.equal((await updater.checkForUpdate()).ok, true)
    assert.ok(events.includes('progress:finish:false:Synthetic structured failure'))
    console.log('updater-adapter-ok')
  `)
}, 30_000)

test('compiled release checks and applies bypass the source queue and retain their own progress path', async () => {
  await scratchAdapter(`
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let resolveCheck
    const blocked = new Promise(resolve => resolveCheck = resolve)
    const events = []
    let options
    mock.module(${moduleUrl('config.ts')}, () => ({ APP_ROOT: '/synthetic/updater', IS_RELEASE: true, SERVICE_NAME: 'synthetic' }))
    mock.module(${moduleUrl('core/process.ts')}, () => ({ spawnCaptured: () => { throw new Error('Release used source spawn') } }))
    mock.module(${moduleUrl('updater-engine.mjs')}, () => ({ createUpdater: () => ({
      checkForUpdate: () => { throw new Error('Release used source check') },
      applyUpdate: () => { throw new Error('Release used source apply') },
    }) }))
    mock.module(${moduleUrl('update-progress.ts')}, () => ({
      beginUpdateProgress: () => { throw new Error('Release used source progress') },
      setUpdatePhase: () => { throw new Error('Release used source progress') },
      finishUpdateProgress: () => { throw new Error('Release used source progress') },
    }))
    mock.module(${moduleUrl('github-updater.ts')}, () => ({
      checkForUpdate: async opts => { options = opts; events.push('release-check'); await blocked; return { ok: true, release: true } },
      applyUpdate: async () => { events.push('release-apply'); return { ok: true, message: 'release-applied' } },
    }))
    const updater = await import(${moduleUrl('updater.ts')})
    const opts = { fresh: true }
    const check = updater.checkForUpdate(opts)
    assert.deepEqual(await updater.applyUpdate(), { ok: true, message: 'release-applied' })
    assert.deepEqual(events, ['release-check', 'release-apply'])
    assert.equal(options, opts)
    resolveCheck()
    assert.deepEqual(await check, { ok: true, release: true })
    console.log('updater-adapter-ok')
  `)
}, 30_000)

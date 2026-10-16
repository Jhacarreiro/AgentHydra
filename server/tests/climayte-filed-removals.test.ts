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
    !basename(target).startsWith('ah-climayte-filed-')
  )
    throw new Error('Refusing unexpected scratch cleanup')
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    // Windows can briefly hold an exited child's scratch files; the preload sweeps these later.
    const code = (error as { code?: string }).code
    if (code !== 'EBUSY' && code !== 'EPERM') throw error
  }
}

/** Actual core save() against a capturing writer, isolated from other tests and real state. */
async function scratchSave(body: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ah-climayte-filed-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    const actual = [], legacy = [], events = []
    const capture = (files, store) => ({ files: new Map(files), store: { ...store } })
    mock.module(${moduleUrl('climayte-store-writer.ts')}, () => ({
      queueStoreWrite: (files, store) => { actual.push(capture(files, store)); events.push('save') },
      queueSideWrite: () => {},
    }))
    mock.module(${moduleUrl('climayte-browser-tabs.ts')}, () => ({
      closeWorkerTabs: async () => { events.push('tabs') },
    }))
    const core = await import(${moduleUrl('climayte-core.ts')})
    core.load()
    assert.equal(core.workers.size, 0)
    const oldWorkers = new Map(), oldFiled = new Set(), oldDirty = new Set()
    const donePath = id => join(core.ROOT, 'done', id + '.json')
    const finished = w => w.status === 'done' || w.status === 'failed' || w.status === 'cancelled'
    // The previous production algorithm is the checkpoint oracle, including its failure behavior.
    function oldSave() {
      const files = new Map(), hot = []
      for (const w of oldWorkers.values()) {
        if (!finished(w)) hot.push(w)
        else if (oldDirty.has(w.id) || !oldFiled.has(w.id)) {
          files.set(donePath(w.id), JSON.stringify(w, null, 2))
          oldFiled.add(w.id)
        }
      }
      oldDirty.clear()
      for (const id of oldFiled) {
        const w = oldWorkers.get(id)
        if (w && finished(w)) continue
        files.set(donePath(id), null)
        oldFiled.delete(id)
      }
      legacy.push(capture(files, {
        path: join(core.ROOT, 'workers.json'),
        text: JSON.stringify({ workers: hot, perAccount: {}, perAccountStrict: {} }, null, 2),
      }))
    }
    function worker(id, status = 'done') {
      return {
        id, group: 'synthetic-filed', title: id, cwd: '/synthetic', prompt: 'Synthetic task',
        pending: [], model: null, effort: null, accounts: null, status, sessionId: null,
        accountId: null, attempts: [], result: null, results: [], error: null,
        lastActivity: null, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        turns: 0, moves: 0, retries: 0, notBefore: null, createdAt: 1000, updatedAt: 1000,
      }
    }
    function put(key, w) {
      assert.equal(core.workers.set(key, w), core.workers, 'Map.set returns this')
      oldWorkers.set(key, w)
      assert.deepEqual([...core.workers], [...oldWorkers], 'Map order and replacement match')
      return w
    }
    function remove(id) {
      assert.equal(core.workers.delete(id), oldWorkers.delete(id), 'Map.delete returns the same boolean')
    }
    function clear() {
      assert.equal(core.workers.clear(), undefined, 'Map.clear returns undefined')
      oldWorkers.clear()
      assert.equal(core.workers.size, 0)
    }
    function dirty(w) { core.markForSave(w); oldDirty.add(w.id) }
    const sorted = map => [...map].sort(([a], [b]) => a.localeCompare(b))
    function equalRound(a, b, label) {
      assert.deepEqual(sorted(a.files), sorted(b.files), label + ': exact file operations')
      assert.deepEqual(a.store, b.store, label + ': exact hot-store text and ordering')
    }
    const diskA = new Map(), diskB = new Map()
    let pendingA = null, pendingB = null
    function merge(pending, round) {
      if (!pending) return capture(round.files, round.store)
      for (const [path, text] of round.files) pending.files.set(path, text)
      pending.store = round.store
      return pending
    }
    // The production writer runs writes, then workers.json, then removals. File operations
    // inside a phase are concurrent, so compare every prefix in the same canonical path order.
    function drain(a, b, label) {
      const writes = round => sorted(round.files).filter(([, text]) => text !== null)
      const removals = round => sorted(round.files).filter(([, text]) => text === null)
      const aa = writes(a), bb = writes(b)
      assert.equal(aa.length, bb.length)
      for (let i = 0; i < aa.length; i++) {
        diskA.set(...aa[i]); diskB.set(...bb[i])
        assert.deepEqual(sorted(diskA), sorted(diskB), label + ': pre-store write prefix ' + i)
      }
      diskA.set(a.store.path, a.store.text); diskB.set(b.store.path, b.store.text)
      assert.deepEqual(sorted(diskA), sorted(diskB), label + ': store checkpoint')
      const ar = removals(a), br = removals(b)
      assert.equal(ar.length, br.length)
      for (let i = 0; i < ar.length; i++) {
        diskA.delete(ar[i][0]); diskB.delete(br[i][0])
        assert.deepEqual(sorted(diskA), sorted(diskB), label + ': post-store removal prefix ' + i)
      }
    }
    function checkpoint(label, expectedError = null, defer = false) {
      const before = actual.length
      let aError = null, bError = null
      try { core.save() } catch (error) { aError = error.message }
      try { oldSave() } catch (error) { bError = error.message }
      assert.equal(aError, expectedError, label + ': actual error')
      assert.equal(bError, expectedError, label + ': legacy error')
      assert.equal(actual.length, legacy.length, label + ': queued checkpoint count')
      if (actual.length === before) return
      const a = actual.at(-1), b = legacy.at(-1)
      equalRound(a, b, label)
      pendingA = merge(pendingA, a); pendingB = merge(pendingB, b)
      equalRound(pendingA, pendingB, label + ': queued-prefix merge')
      if (!defer) { drain(pendingA, pendingB, label); pendingA = null; pendingB = null }
    }
    ${body}
    console.log('filed-save-ok')
  `
  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 30_000,
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
    if (code !== 0) throw new Error(`Scratch save failed (${code}): ${err}\n${out}`)
    expect(out.trim()).toBe('filed-save-ok')
  } finally {
    cleanup(home)
  }
}

test('filed removals preserve Map semantics and each checkpoint across revival, replacement, rebuild and queued writes', async () => {
  await scratchSave(`
    const a = put('a', worker('a')), b = put('b', worker('b', 'failed'))
    const c = put('c', worker('c', 'running'))
    checkpoint('initial files')
    assert.equal(actual.at(-1).files.size, 2)
    a.status = 'queued' // Direct status mutations must be visible without markForSave.
    checkpoint('direct revival', null, true)
    assert.equal(actual.at(-1).files.get(donePath('a')), null)
    assert.ok(JSON.parse(actual.at(-1).store.text).workers.some(w => w.id === 'a'))
    c.status = 'done'; dirty(c)
    checkpoint('finish before leaving hot store', null, true)
    assert.equal(typeof actual.at(-1).files.get(donePath('c')), 'string')
    assert.ok(!JSON.parse(actual.at(-1).store.text).workers.some(w => w.id === 'c'))
    put('b', worker('b', 'running'))
    checkpoint('replace filed value under the same key')
    remove('c'); put('c', c)
    checkpoint('remove and reinsert finished value')
    assert.equal(actual.at(-1).files.size, 0)
    remove('c'); c.status = 'queued'; put('c', c)
    checkpoint('remove and reinsert revived value')
    remove('missing')
    b.status = 'cancelled'; put('b', b); dirty(b)
    checkpoint('refile cancelled value')
    const entries = [...oldWorkers]
    clear(); for (const [id, w] of entries.slice().reverse()) put(id, w)
    checkpoint('clear and reorder without losing filed values')
    clear(); put('a', a)
    checkpoint('clear and rebuild a subset')
    put('orphan', worker('orphan')); checkpoint('seed absent filed key')
    // A normal delete must still account for a filed key already absent from the Map.
    Map.prototype.delete.call(core.workers, 'orphan'); oldWorkers.delete('orphan')
    remove('orphan'); checkpoint('absent delete still removes a filed checkpoint')
    assert.equal(actual.at(-1).files.get(donePath('orphan')), null)
    put('alias', worker('aliased-id'))
    checkpoint('legacy compatibility for mismatched keys')
    assert.equal(actual.at(-1).files.get(donePath('aliased-id')), null)
    remove('alias'); put('alias', worker('alias'))
    checkpoint('replacement restores normal key identity')
    clear(); checkpoint('clear all files')
    assert.deepEqual(JSON.parse(actual.at(-1).store.text).workers, [])
    const final = put('event-order', worker('event-order', 'running'))
    core.listeners.add(() => events.push('notify'))
    events.length = 0
    core.changed(final)
    oldDirty.add(final.id); oldSave()
    equalRound(actual.at(-1), legacy.at(-1), 'changed checkpoint')
    assert.deepEqual(events, ['save', 'notify', 'tabs'], 'Save remains immediate before notification and cleanup')
  `)
}, 40_000)

test('filed checkpoint failures preserve the previous serialization and recovery behavior', async () => {
  await scratchSave(`
    const first = put('first', worker('first')), second = put('second', worker('second'))
    checkpoint('seed files')
    first.result = 'Synthetic updated result'; dirty(first); dirty(second)
    second.toJSON = () => { throw new Error('synthetic done serialization') }
    checkpoint('failed done serialization', 'synthetic done serialization')
    delete second.toJSON
    checkpoint('retry after done serialization failure')
    assert.equal(actual.at(-1).files.size, 2, 'Dirty records survive the failed first pass')
    first.status = 'running'
    first.toJSON = () => { throw new Error('synthetic hot serialization') }
    remove('second')
    checkpoint('failed hot serialization', 'synthetic hot serialization')
    delete first.toJSON
    checkpoint('retry after hot serialization failure')
    // This intentionally preserves legacy mutation/checkpoint timing, rather than introducing
    // a separate failed-write recovery redesign in an optimization of the redundant scan.
    assert.equal(actual.at(-1).files.size, 0)
    first.status = 'done'; dirty(first)
    checkpoint('later finished checkpoint remains equivalent')
  `)
}, 40_000)

test('a sparse active save reads 17,425 finished statuses once and does no redundant filed Map lookups', async () => {
  await scratchSave(`
    const count = 17425
    let reads = 0, actualGets = 0, legacyGets = 0
    for (let i = 0; i < count; i++) {
      const w = worker('history-' + i)
      Object.defineProperty(w, 'status', { enumerable: true, get: () => { reads++; return 'done' } })
      core.workers.set(w.id, w); oldWorkers.set(w.id, w)
    }
    const active = put('active', worker('active', 'running'))
    core.save(); oldSave()
    equalRound(actual.at(-1), legacy.at(-1), 'large initial filing')
    actual.length = 0; legacy.length = 0
    const getActual = core.workers.get.bind(core.workers), getLegacy = oldWorkers.get.bind(oldWorkers)
    core.workers.get = id => { actualGets++; return getActual(id) }
    oldWorkers.get = id => { legacyGets++; return getLegacy(id) }
    active.error = 'Synthetic sparse update'; dirty(active)
    reads = 0; core.save(); const actualReads = reads
    reads = 0; oldSave(); const legacyReads = reads
    equalRound(actual.at(-1), legacy.at(-1), 'large sparse checkpoint')
    assert.equal(actualGets, 0, 'Unchanged filed history must not be looked up a second time')
    assert.equal(legacyGets, count)
    assert.equal(actualReads, count)
    assert.equal(legacyReads, count * 2)
    assert.equal(actual.at(-1).files.size, 0)
    assert.equal(JSON.parse(actual.at(-1).store.text).workers.length, 1)
  `)
}, 40_000)

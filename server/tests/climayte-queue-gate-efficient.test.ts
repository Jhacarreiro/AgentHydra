import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = (name: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', name)).href)

/** Synthetic state and store only: isolated mocks cannot leak into the real queue tests. */
async function scratchQueue(body: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { mock, spyOn } from 'bun:test'
    import assert from 'node:assert/strict'
    import { randomBytes } from 'node:crypto'
    const workers = new Map(), live = new Map()
    let projections = 0, compressions = 0, warmBuild = 0, warmJobs = 0, titleReads = 0
    mock.module(${moduleUrl('climayte-core.ts')}, () => ({ workers, liveByAccount: live }))
    mock.module(${moduleUrl('climayte-lib.ts')}, () => ({ ranSeconds: () => 0 }))
    mock.module(${moduleUrl('core/cli-instances.ts')}, () => ({
      adoptCliInstancePlacements: () => {}, cliInstancePlacements: () => ({}),
    }))
    mock.module(${moduleUrl('core/own-build.ts')}, () => ({
      ownBuild: () => null, readOwnBuild: async () => { warmBuild++; return null },
    }))
    mock.module(${moduleUrl('hswarm.ts')}, () => ({
      getHSwarmStatus: () => { warmJobs++; return { running: false } },
      hswarmHome: () => { throw new Error('Unexpected real HSwarm home read') },
    }))
    mock.module(${moduleUrl('sessions.ts')}, () => ({
      getSession: async () => { titleReads++; return { title: 'Synthetic warmed origin' } },
    }))
    globalThis.fetch = () => { throw new Error('Unexpected network call') }
    const zstd = Bun.zstdCompressSync.bind(Bun)
    spyOn(Bun, 'zstdCompressSync').mockImplementation((...args) => { compressions++; return zstd(...args) })
    const q = await import(${moduleUrl('core/climayte-queue-sync.ts')})
    const remote = await import(${moduleUrl('climayte-remote.ts')})
    const T = 1800000000000
    const A = '11111111-1111-4111-8111-111111111111'
    const B = '22222222-2222-4222-8222-222222222222'
    const OTHER = '33333333-3333-4333-8333-333333333333'
    const key = Buffer.alloc(32, 7)
    const puts = [], versions = new Map()
    let failPut = false, remoteVersion = 0, remoteBlob = '', remoteGets = 0, listReads = 0
    const call = async (method, path, body) => {
      if (path === '/v1/queues') {
        listReads++
        return { status: 200, json: { queues: [
          ...[...versions].map(([pc, version]) => ({ pc, version })),
          ...(remoteVersion ? [{ pc: OTHER, version: remoteVersion }] : []),
        ] } }
      }
      if (method === 'GET' && path === '/v1/queues/' + OTHER) {
        remoteGets++
        return { status: 200, json: { blob: remoteBlob, version: remoteVersion } }
      }
      if (method === 'GET' && path.startsWith('/v1/queues/')) {
        const pc = path.split('/').at(-1)
        const previous = puts.findLast(put => put.pc === pc)
        assert.ok(previous, 'Synthetic PC must have uploaded before it can be downloaded')
        return { status: 200, json: { blob: previous.body.blob, version: versions.get(pc) } }
      }
      if (method === 'PUT') {
        if (failPut) { failPut = false; return { status: 503, json: { error: 'Synthetic failed upload' } } }
        const pc = path.split('/').at(-1)
        const version = (versions.get(pc) ?? 0) + 1
        versions.set(pc, version)
        puts.push({ pc, body, decoded: q.openQueue(key, pc, body.blob) })
        return { status: 200, json: { version } }
      }
      throw new Error('Unexpected synthetic store operation: ' + method + ' ' + path)
    }
    const io = pc => ({ pc, key, name: 'Synthetic PC', call })
    function worker(id, status = 'running', updatedAt = T) {
      const w = {
        id, title: id, group: 'synthetic-group', status, attempts: [], accountId: null,
        model: null, effort: null, createdAt: T, updatedAt, costUsd: 0,
        lastActivity: null, error: null, sessionId: null,
      }
      Object.defineProperty(w, 'cwd', { enumerable: true, get: () => { projections++; return '/synthetic/folder' } })
      workers.set(id, w)
      return w
    }
    function resetCounts() { projections = 0; compressions = 0 }
    function reset() {
      q.resetQueueSync(); remote.clearRemote(); workers.clear(); live.clear()
      puts.length = 0; versions.clear(); remoteVersion = 0; resetCounts()
    }
    ${body}
    console.log('queue-gate-ok')
  `,
    ],
    {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 30_000,
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Scratch queue failed (${code}): ${err}\n${out}`)
  expect(out.trim()).toBe('queue-gate-ok')
}

test('the minimum queue gate skips projection and compression while preserving boundaries, failed uploads, PCs and remote warming', async () => {
  await scratchQueue(`
    reset()
    const w = worker('one')
    assert.equal(await q.syncQueue(io(A), T), true)
    assert.equal(puts.length, 1)
    w.title = 'Synthetic changed shape'
    resetCounts()
    assert.equal(q.queueUploadPending(A, T - 1), false)
    assert.equal(q.queueUploadPending(A, T + q.QUEUE_SHAPE_GAP_MS - 1), false)
    assert.equal(projections, 0)
    assert.equal(compressions, 0)
    w.origin = { kind: 'chat', sessionId: 'synthetic-origin' }
    remoteVersion = 1
    remoteBlob = q.sealQueue(key, { pc: OTHER, name: 'Other synthetic PC', at: T, workers: [], live: {} })
    resetCounts()
    const before = { warmBuild, warmJobs, titleReads, listReads }
    assert.equal(await q.syncQueue(io(A), T + q.QUEUE_SHAPE_GAP_MS - 1), true, 'Remote news still downloads')
    assert.equal(puts.length, 1)
    assert.equal(projections, 0, 'Rejected local upload must not project workers')
    assert.equal(compressions, 0, 'Rejected local upload must not fit or seal')
    assert.equal(remoteGets, 1)
    assert.equal(warmBuild, before.warmBuild + 1)
    assert.equal(warmJobs, before.warmJobs + 1)
    assert.equal(titleReads, before.titleReads + 1)
    assert.equal(listReads, before.listReads + 1)
    assert.equal(q.originChatTitle('synthetic-origin'), 'Synthetic warmed origin')
    assert.equal(q.queueUploadPending(A, T + q.QUEUE_SHAPE_GAP_MS), true)
    assert.equal(await q.syncQueue(io(A), T + q.QUEUE_SHAPE_GAP_MS), true)
    assert.equal(puts.length, 2)
    assert.equal(puts.at(-1).decoded.workers[0].title, w.title)
    assert.equal(puts.at(-1).decoded.workers[0].originTitle, 'Synthetic warmed origin')
    assert.ok(projections > 0 && compressions > 0, 'Exact boundary runs the existing full fit')
    assert.equal(q.queueUploadPending(B, T + q.QUEUE_SHAPE_GAP_MS + 1), true)
    assert.equal(await q.syncQueue(io(B), T + q.QUEUE_SHAPE_GAP_MS + 1), true)
    assert.equal(puts.at(-1).pc, B, 'Another PC has its own gate')
    reset()
    worker('failed-first')
    failPut = true
    await assert.rejects(q.syncQueue(io(A), T), /Synthetic failed upload/)
    assert.equal(q.queueUploadPending(A, T + 1), true, 'Failed PUT must not begin a gate')
    resetCounts()
    assert.equal(await q.syncQueue(io(A), T + 1), true)
    assert.ok(projections > 0 && compressions > 0)
  `)
}, 40_000)

test('live-only changes retain the ten-minute gate and large snapshots retain identical fitting after the minimum gap', async () => {
  await scratchQueue(`
    reset()
    const reading = { sessionPct: 20, weekPct: 0, at: T }
    live.set('synthetic-account', reading)
    await q.syncQueue(io(A), T)
    reading.sessionPct = 26
    resetCounts()
    assert.equal(q.queueUploadPending(A, T + q.QUEUE_SHAPE_GAP_MS - 1), false)
    assert.equal(await q.syncQueue(io(A), T + q.QUEUE_SHAPE_GAP_MS - 1), false)
    assert.equal(compressions, 0)
    assert.equal(q.queueUploadPending(A, T + q.QUEUE_SHAPE_GAP_MS), false)
    assert.equal(await q.syncQueue(io(A), T + q.LIVE_GATE_MS - 1), false)
    assert.equal(puts.length, 1)
    assert.equal(q.queueUploadPending(A, T + q.LIVE_GATE_MS), true)
    assert.equal(await q.syncQueue(io(A), T + q.LIVE_GATE_MS), true)
    assert.equal(puts.length, 2)
    assert.equal(puts.at(-1).decoded.live['synthetic-account'].sessionPct, 26)
    reset()
    for (let i = 0; i < 1500; i++) worker('history-' + i, 'done', T - i).title = randomBytes(150).toString('hex')
    const activeIds = ['queued', 'running', 'waiting', 'checking'].map(status => {
      const id = 'active-' + status
      worker(id, status, T - 2000)
      return id
    })
    await q.syncQueue(io(A), T)
    assert.ok(compressions > 1, 'Fixture must exercise binary-search compression')
    const first = puts.at(-1).decoded
    assert.ok(first.workers.length < workers.size)
    for (const id of activeIds) assert.ok(first.workers.some(w => w.id === id))
    const moved = workers.get('history-1499')
    moved.updatedAt = T + q.QUEUE_SHAPE_GAP_MS
    moved.title = 'Synthetic newest finished worker'
    resetCounts()
    assert.equal(await q.syncQueue(io(A), T + q.QUEUE_SHAPE_GAP_MS - 1), false)
    assert.equal(projections, 0)
    assert.equal(compressions, 0)
    const now = T + q.QUEUE_SHAPE_GAP_MS
    const expected = q.fitSnapshot(key, q.buildSnapshot(A, 'Synthetic PC', now)).snap
    resetCounts()
    assert.equal(await q.syncQueue(io(A), now), true)
    assert.deepEqual(puts.at(-1).decoded, expected, 'Existing fitting, truncation and ordering are unchanged')
    assert.ok(compressions > 1)
    assert.ok(projections >= workers.size)
    assert.ok(puts.at(-1).decoded.workers.some(w => w.id === moved.id))
    assert.ok(puts.at(-1).body.blob.length <= q.QUEUE_MAX_BLOB)
    for (const id of activeIds) assert.ok(puts.at(-1).decoded.workers.some(w => w.id === id))
  `)
}, 40_000)

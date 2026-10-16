import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'hono'
import { profileSinceStart, startStallSentinel, stopStallSentinel } from '../src/stall-sentinel'

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  stopStallSentinel()
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
})

function fixture() {
  let now = 100_000
  let beat!: () => void
  const worker = { unref: mock(() => {}), postMessage: mock((_message: unknown) => {}) }
  const timer = { unref: mock(() => {}) }
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  // Bun's spy type accepts callable members; the spy wrapper handles construction at runtime.
  const workerGlobal = globalThis as unknown as { Worker: (...args: unknown[]) => Worker }
  const workerConstructor = spyOn(workerGlobal, 'Worker').mockImplementation(
    () => worker as unknown as Worker,
  )
  const objectURL = spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-stall-worker')
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: unknown) => {
    beat = callback as () => void
    return timer as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const cleared = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  spies.push(clock, workerConstructor, objectURL, interval, cleared, errors)
  const start = mock((_directory?: string, _interval?: number) => {})
  const drain = mock(() => ({
    traces: [
      {
        frames: [
          { name: 'syntheticWork', sourceURL: '/synthetic/server/src/example-work.ts', line: 17 },
        ],
      },
    ],
  }))
  return {
    start,
    drain,
    worker,
    timer,
    interval,
    cleared,
    errors,
    tick: (at: number) => {
      now = at
      beat()
    },
  }
}

test('sampling still starts at boot in microseconds while heartbeat and two-second drains stay unchanged', () => {
  const f = fixture()
  const before = profileSinceStart(0).samples
  startStallSentinel(null, { startSamplingProfiler: f.start, samplingProfilerStackTraces: f.drain })
  expect(f.start.mock.calls).toEqual([[undefined, 8_000]])
  expect(f.interval.mock.calls[0]?.[1]).toBe(250)
  expect(f.timer.unref).toHaveBeenCalledTimes(1)
  expect(f.worker.unref).toHaveBeenCalledTimes(1)
  expect(f.worker.postMessage.mock.calls[0]?.[0]).toMatchObject({
    t: 'init',
    logPath: null,
    steps: [2_000, 5_000, 9_000, 15_000, 30_000, 60_000],
    repeat: 60_000,
  })
  f.tick(100_250)
  f.tick(101_999)
  expect(f.drain).not.toHaveBeenCalled()
  f.tick(102_000)
  expect(f.drain).toHaveBeenCalledTimes(1)
  f.tick(103_999)
  expect(f.drain).toHaveBeenCalledTimes(1)
  f.tick(104_000)
  expect(f.drain).toHaveBeenCalledTimes(2)
  expect(profileSinceStart(0).samples).toBe(before + 2)
  expect(f.errors).not.toHaveBeenCalled()
  stopStallSentinel()
  expect(f.cleared).toHaveBeenCalledTimes(1)
})

test('a two-second late beat still records the sampled function and the responsible request', async () => {
  const f = fixture()
  const middleware = startStallSentinel(null, {
    startSamplingProfiler: f.start,
    samplingProfilerStackTraces: f.drain,
  })
  await middleware(
    {
      req: { method: 'GET', url: 'http://hydra.example.test/api/synthetic' },
    } as unknown as Context,
    async () => {},
  )
  f.tick(102_250)
  expect(f.drain).toHaveBeenCalledTimes(1)
  expect(f.errors).toHaveBeenCalledTimes(1)
  expect(String(f.errors.mock.calls[0]?.[0])).toContain('STALL one block of 2.0s')
  expect(String(f.errors.mock.calls[0]?.[0])).toContain('GET /api/synthetic')
  expect(String(f.errors.mock.calls[0]?.[0])).toContain('syntheticWork example-work.ts:17')
  expect(f.worker.postMessage.mock.calls.map(([message]) => (message as { t: string }).t)).toEqual([
    'init',
    'begin',
    'end',
  ])
})

test('an unavailable sampler leaves both heartbeat detectors running without drain failures', () => {
  const f = fixture()
  f.start.mockImplementation(() => {
    throw new Error('Synthetic unsupported runtime')
  })
  startStallSentinel(null, { startSamplingProfiler: f.start, samplingProfilerStackTraces: f.drain })
  expect(f.interval.mock.calls[0]?.[1]).toBe(250)
  f.tick(102_250)
  expect(f.drain).not.toHaveBeenCalled()
  expect(f.errors).not.toHaveBeenCalled()
  expect(f.worker.postMessage).toHaveBeenCalledTimes(1)
})

test('the actual sampler still names an intentional long block in an isolated process', async () => {
  const sentinel = pathToFileURL(resolve(import.meta.dir, '../src/stall-sentinel.ts')).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    const { startStallSentinel, stopStallSentinel, profileSinceStart } = await import(${JSON.stringify(sentinel)})
    startStallSentinel(null)
    await Bun.sleep(400)
    let sink = 17
    function syntheticSentinelBlock() {
      const until = performance.now() + 2300
      while (performance.now() < until)
        for (let i = 0; i < 10000; i++) sink = (Math.imul(sink ^ i, 1664525) + 1013904223) | 0
    }
    syntheticSentinelBlock()
    await Bun.sleep(400)
    stopStallSentinel()
    console.log('@@sentinel@@' + JSON.stringify({ samples: profileSinceStart(0).samples, sink }))
  `,
    ],
    {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 12_000,
      windowsHide: true,
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(0)
  expect(stderr).toContain('STALL one block of')
  expect(stderr).toContain('syntheticSentinelBlock')
  const line = stdout.split('\n').find((line) => line.startsWith('@@sentinel@@'))
  expect(line).toBeDefined()
  expect(JSON.parse(line!.slice('@@sentinel@@'.length)).samples).toBeGreaterThan(0)
}, 15_000)

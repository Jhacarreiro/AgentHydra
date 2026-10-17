import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import type { SpawnOffOptions, WorkerReply, WorkerRequest } from '../src/lib/spawn-off'

// Execute the real worker source with synthetic pipes, timers and spawn. No OS helper is launched.
const source = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(
  readFileSync(new URL('../src/lib/spawn-off.worker.ts', import.meta.url), 'utf8'),
)
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const TIMEOUT = 137

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (ready()) return
    await Promise.resolve()
  }
  throw new Error('Synthetic worker did not advance')
}

function pipe(parts: Uint8Array[], cancelMode: 'hung' | 'rejected' = 'hung') {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let sent = 0
  let waiting = false
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull(value) {
        const bytes = parts[sent++]
        if (bytes) value.enqueue(bytes)
        else waiting = true
      },
      cancel() {
        cancelled++
        return cancelMode === 'hung'
          ? new Promise<void>(() => {})
          : Promise.reject(new Error('Synthetic cancel rejection'))
      },
    },
    { highWaterMark: 0 },
  )
  return {
    stream,
    waiting: () => waiting,
    cancelled: () => cancelled,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: () => controller.error(new Error('Synthetic read failure')),
  }
}

function fixture(
  options: {
    cancelMode?: 'hung' | 'rejected'
    exitCode?: number | null
    killThrows?: boolean
    out?: Uint8Array[]
    err?: Uint8Array[]
  } = {},
) {
  const out = pipe(options.out ?? [encoder.encode('Synthetic stdout 🙂\n')], options.cancelMode)
  const errBytes = encoder.encode('\ufeff  Synthetic diagnostic 🙂  \n')
  const err = pipe(
    options.err ?? [
      errBytes.subarray(0, 4),
      errBytes.subarray(4, errBytes.length - 4),
      errBytes.subarray(errBytes.length - 4),
    ],
    options.cancelMode,
  )
  const timers: Array<{ ms: number; callback: () => void; cleared: boolean }> = []
  const replies: WorkerReply[] = []
  const spawns: Array<{ cmd: string[]; options: Record<string, unknown> }> = []
  const exit = Promise.withResolvers<number>()
  let exitCode = options.exitCode === undefined ? 3 : options.exitCode
  if (exitCode !== null) exit.resolve(exitCode)
  let kills = 0
  let decoded = 0
  const proc = {
    stdout: out.stream,
    stderr: err.stream,
    exited: exit.promise,
    pid: 12345,
    get exitCode() {
      return exitCode
    },
    kill() {
      kills++
      if (options.killThrows) throw new Error('Synthetic kill refusal')
    },
  }
  const self = {
    onmessage: undefined as ((event: { data: WorkerRequest }) => void) | undefined,
    postMessage(reply: WorkerReply, transfer: ArrayBuffer[]) {
      if (reply.type === 'result') {
        expect(transfer).toHaveLength(1)
        expect(transfer[0] === reply.result.stdout.buffer).toBe(true)
      }
      replies.push(reply)
    },
  }
  function SyntheticDecoder() {
    const value = new TextDecoder()
    const decode = value.decode.bind(value)
    value.decode = (bytes, options) => {
      decoded++
      return decode(bytes, options)
    }
    return value
  }
  runInNewContext(source, {
    self,
    process: { platform: 'win32' },
    Bun: {
      spawn(cmd: string[], options: Record<string, unknown>) {
        spawns.push({ cmd, options })
        return proc
      },
    },
    Blob,
    TextDecoder: SyntheticDecoder,
    setTimeout(callback: () => void, ms: number) {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer: { cleared: boolean } | undefined) {
      if (timer) timer.cleared = true
    },
  })
  return {
    out,
    err,
    replies,
    spawns,
    timers,
    decoded: () => decoded,
    kills: () => kills,
    start(opts: Partial<SpawnOffOptions> = {}) {
      self.onmessage?.({
        data: {
          type: 'spawn',
          id: 1,
          opts: { cmd: ['synthetic-only'], timeoutMs: TIMEOUT, ...opts },
        },
      })
    },
    abort() {
      self.onmessage?.({ data: { type: 'abort', id: 1 } })
    },
    hasTimer: (ms: number) => timers.some((timer) => timer.ms === ms && !timer.cleared),
    fire(ms: number) {
      const timer = timers.find((timer) => timer.ms === ms && !timer.cleared)
      if (!timer) throw new Error(`Missing synthetic ${ms} ms timer`)
      timer.cleared = true
      timer.callback()
    },
    finish(code: number) {
      exitCode = code
      exit.resolve(code)
    },
    result() {
      const reply = replies[0]
      if (reply?.type !== 'result') throw new Error('Expected a synthetic worker result')
      return reply.result
    },
  }
}

for (const reason of ['timedOut', 'aborted', 'capped'] as const) {
  for (const cancelMode of ['hung', 'rejected'] as const) {
    test(`${reason} settles inherited pipes despite ${cancelMode} underlying cancel`, async () => {
      const f = fixture({ cancelMode })
      f.start({ killTree: true, ...(reason === 'capped' ? { maxBytes: 4 } : {}) })
      await until(() => f.out.waiting() && f.err.waiting())
      if (reason === 'timedOut') f.fire(TIMEOUT)
      if (reason === 'aborted') f.abort()
      await until(() => f.hasTimer(2_000))
      expect(f.replies).toHaveLength(0)
      expect(f.out.cancelled()).toBe(0)
      expect(f.err.cancelled()).toBe(0)
      expect(f.spawns.map((call) => call.cmd[0])).toEqual(['synthetic-only', 'taskkill'])
      expect(f.spawns.every((call) => call.options.windowsHide === true)).toBe(true)
      f.fire(2_000)
      await until(() => f.replies.length === 1 && !f.out.stream.locked && !f.err.stream.locked)
      expect(f.result()).toMatchObject({
        code: 3,
        capped: reason === 'capped',
        timedOut: reason === 'timedOut',
        aborted: reason === 'aborted',
        stderr: 'Synthetic diagnostic 🙂',
      })
      expect(decoder.decode(f.result().stdout)).toBe(
        reason === 'capped' ? 'Synt' : 'Synthetic stdout 🙂\n',
      )
      expect(f.out.cancelled()).toBe(1)
      expect(f.err.cancelled()).toBe(1)
      const decoded = f.decoded()
      expect(() => f.out.write('Later stdout')).toThrow()
      expect(() => f.err.write('Later stderr')).toThrow()
      await Promise.resolve()
      expect(f.decoded()).toBe(decoded)
      expect(f.timers.every((timer) => timer.cleared)).toBe(true)
      f.abort()
      expect(f.spawns).toHaveLength(2)
    })
  }
}

test('a refused kill still returns its partial output and unknown exit code at the grace bound', async () => {
  const f = fixture({ exitCode: null, killThrows: true })
  f.start({ stderr: 'ignore' })
  await until(() => f.out.waiting())
  f.fire(TIMEOUT)
  await until(() => f.hasTimer(2_000))
  f.fire(2_000)
  await until(() => f.replies.length === 1 && !f.out.stream.locked)
  expect(f.result()).toMatchObject({
    code: -1,
    stderr: '',
    timedOut: true,
    capped: false,
    aborted: false,
  })
  expect(decoder.decode(f.result().stdout)).toBe('Synthetic stdout 🙂\n')
  expect(f.kills()).toBe(1)
  expect(f.err.cancelled()).toBe(0)
  expect(f.decoded()).toBe(0)
})

test('normal EOF releases readers without cancellation and preserves raw stdout and decoded stderr', async () => {
  const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0xf0, 0x9f, 0x99, 0x82])
  const f = fixture({ out: [raw.subarray(0, 4), raw.subarray(4)] })
  f.start()
  await until(() => f.out.waiting() && f.err.waiting())
  f.out.close()
  f.err.close()
  await until(() => f.replies.length === 1)
  expect([...f.result().stdout]).toEqual([...raw])
  expect(f.result()).toMatchObject({
    code: 3,
    stderr: 'Synthetic diagnostic 🙂',
    capped: false,
    timedOut: false,
    aborted: false,
  })
  expect(f.out.cancelled() + f.err.cancelled()).toBe(0)
  expect(f.out.stream.locked || f.err.stream.locked).toBe(false)
  expect(f.spawns).toHaveLength(1)
  expect(f.timers.every((timer) => timer.cleared)).toBe(true)
})

test('final output and exit during the grace period are included without waiting out the grace', async () => {
  const f = fixture({ exitCode: null })
  f.start()
  await until(() => f.out.waiting() && f.err.waiting())
  f.fire(TIMEOUT)
  await until(() => f.hasTimer(2_000))
  f.out.write('Final stdout')
  f.err.write('Final diagnostic')
  f.out.close()
  f.err.close()
  f.finish(7)
  await until(() => f.replies.length === 1)
  expect(f.result()).toMatchObject({
    code: 7,
    stderr: 'Synthetic diagnostic 🙂  \nFinal diagnostic',
    timedOut: true,
  })
  expect(decoder.decode(f.result().stdout)).toBe('Synthetic stdout 🙂\nFinal stdout')
  expect(f.out.cancelled() + f.err.cancelled()).toBe(0)
  expect(f.timers.every((timer) => timer.cleared)).toBe(true)
})

test('a read failure before a stop stays a failed reply and cancels only the other unfinished reader', async () => {
  const f = fixture()
  f.start()
  await until(() => f.out.waiting() && f.err.waiting())
  f.out.fail()
  await until(() => f.replies.length === 1 && !f.err.stream.locked)
  expect(f.replies[0]).toEqual({ type: 'failed', id: 1, detail: 'Synthetic read failure' })
  expect(f.out.cancelled()).toBe(0)
  expect(f.err.cancelled()).toBe(1)
  expect(f.spawns).toHaveLength(1)
})

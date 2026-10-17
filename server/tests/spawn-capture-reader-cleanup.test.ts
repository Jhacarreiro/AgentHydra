import { expect, spyOn, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { capturePipedProc } from '../src/core/process'
import { captureInWorker, setSpawnWorkerIdleStopForTests } from '../src/core/spawn-worker'

const TIMEOUT = 137
const nativeTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
const NativeDecoder = TextDecoder

function clock() {
  const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = []
  const schedule = (callback: () => void, delay: number) => {
    if (delay !== TIMEOUT && delay !== 2_000) return nativeTimeout(callback, delay)
    const timer = { delay, callback, cancelled: false }
    timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }
  const clear = (timer: ReturnType<typeof setTimeout> | undefined) => {
    const owned = timers.find((item) => item === (timer as unknown))
    if (owned) owned.cancelled = true
    else nativeClearTimeout(timer)
  }
  return {
    schedule,
    clear,
    has: (delay: number) => timers.some((timer) => timer.delay === delay && !timer.cancelled),
    fire(delay: number) {
      const timer = timers.find((timer) => timer.delay === delay && !timer.cancelled)
      if (!timer) throw new Error(`Missing synthetic ${delay} ms timer`)
      timer.cancelled = true
      timer.callback()
    },
  }
}

async function until(ready: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (ready()) return
    await new Promise<void>((resolve) => nativeTimeout(resolve, 0))
  }
  throw new Error('Synthetic capture did not advance')
}

function heldPipe(text: string, cancelMode: 'hung' | 'rejected') {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancellations = 0
  let pulled = false
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull(value) {
        if (!pulled) {
          pulled = true
          value.enqueue(bytes)
        }
      },
      cancel() {
        cancellations++
        return cancelMode === 'hung'
          ? new Promise<void>(() => {})
          : Promise.reject(new Error('Synthetic cancel rejection'))
      },
    },
    { highWaterMark: 0 },
  )
  return {
    stream,
    bytes: bytes.byteLength,
    cancellations: () => cancellations,
    pulled: () => pulled,
    writeLater: () => controller.enqueue(new TextEncoder().encode('Late output')),
  }
}

function decoderCounter() {
  let bytes = 0
  let calls = 0
  const construct = (...args: ConstructorParameters<typeof TextDecoder>) => {
    const decoder = new NativeDecoder(...args)
    const decode = decoder.decode.bind(decoder)
    decoder.decode = (input, options) => {
      bytes += input?.byteLength ?? 0
      calls++
      return decode(input, options)
    }
    return decoder
  }
  return { construct, bytes: () => bytes, calls: () => calls }
}

for (const mode of ['inline', 'worker'] as const) {
  for (const cancelMode of ['hung', 'rejected'] as const) {
    for (const wantStderr of [false, true]) {
      test(`${mode} timeout detaches forever pipes with ${cancelMode} cancel and stderr=${wantStderr}`, async () => {
        const out = heldPipe('Synthetic stdout before deadline\n', cancelMode)
        const err = heldPipe('Synthetic stderr before deadline\n', cancelMode)
        // A supervisor already exited; its inherited pipes can still be held by somebody else.
        const proc = {
          stdout: out.stream,
          stderr: err.stream,
          exited: Promise.resolve(3),
          exitCode: 3,
          killed: false,
        } as unknown as Bun.Subprocess<'ignore', 'pipe', 'pipe'>
        const time = clock()
        const decoded = decoderCounter()
        const spies: Array<{ mockRestore(): void }> = []
        let workerStopped = false
        try {
          let result: ReturnType<typeof capturePipedProc>
          if (mode === 'inline') {
            spies.push(
              spyOn(globalThis, 'setTimeout').mockImplementation(
                time.schedule as typeof setTimeout,
              ),
              spyOn(globalThis, 'clearTimeout').mockImplementation(
                time.clear as typeof clearTimeout,
              ),
              spyOn(
                globalThis as unknown as {
                  TextDecoder: (...args: ConstructorParameters<typeof TextDecoder>) => TextDecoder
                },
                'TextDecoder',
              ).mockImplementation(decoded.construct),
            )
            result = capturePipedProc(proc, { timeoutMs: TIMEOUT, wantStderr })
          } else {
            // Capture the real embedded source, then run it with a synthetic subprocess. This
            // exercises worker capture and reply handling without launching any OS helper.
            let source!: Promise<string>
            const worker = {
              onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
              onerror: undefined as ((event: { message: string }) => void) | undefined,
              unref() {},
              terminate() {
                workerStopped = true
              },
              postMessage(message: unknown) {
                void source
                  .then((text) => {
                    function SyntheticDecoder(...args: ConstructorParameters<typeof TextDecoder>) {
                      return decoded.construct(...args)
                    }
                    const self = {
                      onmessage: undefined as
                        | ((event: { data: unknown }) => Promise<void>)
                        | undefined,
                      postMessage(data: unknown) {
                        worker.onmessage?.({ data })
                      },
                    }
                    runInNewContext(text, {
                      Bun: { spawn: () => proc },
                      process: { platform: 'win32' },
                      self,
                      setTimeout: time.schedule,
                      clearTimeout: time.clear,
                      TextDecoder: SyntheticDecoder,
                    })
                    return self.onmessage?.({ data: message })
                  })
                  .catch((error) => worker.onerror?.({ message: String(error) }))
              },
            }
            spies.push(
              spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
                source = (blob as Blob).text()
                return 'blob:synthetic-reader-cleanup'
              }),
              spyOn(
                globalThis as unknown as { Worker: (...args: unknown[]) => Worker },
                'Worker',
              ).mockImplementation(() => worker as unknown as Worker),
            )
            setSpawnWorkerIdleStopForTests(0)
            result = captureInWorker(['synthetic-only'], {
              timeoutMs: TIMEOUT,
              wantStderr,
              lane: `synthetic-reader-cleanup-${cancelMode}-${wantStderr}`,
            })
          }

          await until(() => time.has(TIMEOUT) && out.pulled() && err.pulled())
          expect(out.cancellations()).toBe(0)
          expect(err.cancellations()).toBe(0)
          time.fire(TIMEOUT)
          await until(() => time.has(2_000))
          // Keep the full existing grace period: only its end permits closing owned readers.
          expect(out.cancellations()).toBe(0)
          expect(err.cancellations()).toBe(0)
          time.fire(2_000)
          expect(await result).toEqual({
            code: 3,
            stdout: 'Synthetic stdout before deadline\n',
            stderr: wantStderr ? 'Synthetic stderr before deadline\n' : '',
            timedOut: true,
          })
          await until(() => !out.stream.locked && !err.stream.locked)
          expect(out.cancellations()).toBe(1)
          expect(err.cancellations()).toBe(1)
          expect(decoded.bytes()).toBe(out.bytes + (wantStderr ? err.bytes : 0))
          const calls = decoded.calls()
          expect(out.writeLater).toThrow()
          expect(err.writeLater).toThrow()
          await Promise.resolve()
          expect(decoded.calls()).toBe(calls)
          if (mode === 'worker') {
            await new Promise<void>((resolve) => nativeTimeout(resolve, 0))
            expect(workerStopped).toBe(true)
          }
        } finally {
          setSpawnWorkerIdleStopForTests()
          for (const spy of spies.reverse()) spy.mockRestore()
        }
      })
    }
  }
}

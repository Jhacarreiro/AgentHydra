// The worker half of spawn-off.ts: starts each process and reads its output on this thread, so the server's
// main thread never waits on process creation. It knows nothing else about the server. Messages in and out
// are the WorkerRequest and WorkerReply types exported from spawn-off.ts.

import type { SpawnOffOptions, SpawnStop, WorkerReply, WorkerRequest } from './spawn-off'

type Subprocess = ReturnType<typeof Bun.spawn>
type Reader = ReadableStreamDefaultReader<Uint8Array>
const STOP_GRACE_MS = 2_000

/** Stops a running process by call id, so an abort message can reach it. */
const stops = new Map<number, (why: SpawnStop) => void>()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'abort') stops.get(msg.id)?.('aborted')
  else void run(msg.id, msg.opts)
}

function post(msg: WorkerReply, transfer: ArrayBuffer[] = []): void {
  self.postMessage(msg, transfer)
}

async function run(id: number, opts: SpawnOffOptions): Promise<void> {
  let proc: Subprocess
  try {
    proc = Bun.spawn(opts.cmd, {
      cwd: opts.cwd,
      env: definedEnv(opts.env),
      stdin: opts.stdin === undefined ? 'ignore' : new Blob([typeof opts.stdin === 'string' ? opts.stdin : new Uint8Array(opts.stdin)]),
      stdout: opts.stdout === 'ignore' ? 'ignore' : 'pipe',
      stderr: opts.stderr === 'ignore' ? 'ignore' : 'pipe',
      windowsHide: true,
    })
  } catch (err) {
    post({ type: 'launch', id, detail: (err as Error).message })
    return
  }
  const state: { stopped?: SpawnStop } = {}
  const stopped = Promise.withResolvers<void>()
  const stop = (why: SpawnStop) => {
    if (state.stopped) return
    state.stopped = why
    try { kill(proc, opts.killTree === true) } catch { /* already gone, or its kill was refused */ }
    stopped.resolve()
  }
  stops.set(id, stop)
  const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => stop('timedOut'), opts.timeoutMs)
  let grace: ReturnType<typeof setTimeout> | undefined
  const readers = new Set<Reader>()
  const out: Stdout = { chunks: [], size: 0, capped: false }
  const err = { text: '' }
  try {
    const work = Promise.all([
      opts.stdout === 'ignore' ? Promise.resolve() : readStdout(proc.stdout as ReadableStream<Uint8Array>, opts.maxBytes ?? Number.POSITIVE_INFINITY, () => stop('capped'), out, readers),
      opts.stderr === 'ignore' ? Promise.resolve() : readStderr(proc.stderr as ReadableStream<Uint8Array>, err, readers),
      proc.exited,
    ]).then(([, , code]) => ({ code }))
    // Killing the supervisor does not guarantee EOF: an inherited pipe can outlive it. Stop
    // requests therefore bound the wait themselves, while allowing final output/exit to land.
    let end = await Promise.race([work, stopped.promise.then(() => null)]).catch(error => {
      if (state.stopped) return null
      throw error
    })
    if (end === null) {
      end = await Promise.race([
        work.catch(() => null),
        new Promise<null>(resolve => { grace = setTimeout(() => resolve(null), STOP_GRACE_MS) }),
      ])
    }
    const bytes = stdoutBytes(out)
    post(
      {
        type: 'result',
        id,
        result: {
          code: end?.code ?? proc.exitCode ?? -1,
          stdout: bytes,
          stderr: err.text.trim(),
          capped: out.capped,
          timedOut: state.stopped === 'timedOut',
          aborted: state.stopped === 'aborted',
        },
      },
      [bytes.buffer],
    )
  } catch (err) {
    post({ type: 'failed', id, detail: (err as Error).message })
  } finally {
    clearTimeout(timer)
    clearTimeout(grace)
    stops.delete(id)
    for (const reader of readers) {
      // Cancellation closes the pending read even if its underlying cancel hook never settles.
      try { void reader.cancel().catch(() => {}) } catch { /* already closed */ }
    }
  }
}

/** Windows kill-tree goes through taskkill, which must run before the root dies or its children are lost. */
function kill(proc: Subprocess, tree: boolean): void {
  if (tree && process.platform === 'win32') {
    try {
      Bun.spawn(['taskkill', '/pid', String(proc.pid), '/t', '/f'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true })
      return
    } catch {
      // taskkill itself could not start: fall back to killing the root process alone.
    }
  }
  proc.kill()
}

interface Stdout { chunks: Uint8Array[]; size: number; capped: boolean }

/** Keeps stdout up to `max`; past it the reader still drains until the stop's grace ends. */
async function readStdout(stream: ReadableStream<Uint8Array>, max: number, onCap: () => void, out: Stdout, readers: Set<Reader>): Promise<void> {
  const reader = stream.getReader()
  readers.add(reader)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (out.capped) continue
      if (out.size + value.length > max) {
        out.chunks.push(value.subarray(0, max - out.size))
        out.size = max
        out.capped = true
        onCap()
        continue
      }
      out.chunks.push(value)
      out.size += value.length
    }
  } finally {
    readers.delete(reader)
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

function stdoutBytes(out: Stdout): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(out.size)
  let at = 0
  for (const chunk of out.chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}

/** Streaming decoding retains diagnostics when an inherited stderr pipe never closes. */
async function readStderr(stream: ReadableStream<Uint8Array>, err: { text: string }, readers: Set<Reader>): Promise<void> {
  const reader = stream.getReader()
  readers.add(reader)
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      err.text += decoder.decode(value, { stream: true })
    }
    err.text += decoder.decode()
  } finally {
    readers.delete(reader)
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

function definedEnv(env?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

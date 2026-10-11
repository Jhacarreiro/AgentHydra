// server/src/core/spawn-worker.ts - a captured child process, spawned and drained on a worker thread.
//
// ⛔ WHY (2026-10-04). Bun.spawn holds the calling thread while the OS creates the process: on this
// Windows PC a CPU profile and a 5 ms loop-lag probe both showed 100-280 ms per call (Defender scans
// the image, CreateProcess is slow under load). The daemon serves every route on one thread, so each
// scan (process list, netstat, secret-store, git) froze /api/health and /api/queue for that long.
// Here the worker pays that cost; the daemon thread posts a message and awaits a promise.
//
// Built from source through a blob URL, like sqlite-worker.ts, so the compiled exe carries it with no
// second build entrypoint. The worker does the WHOLE capture (spawn, drain both streams, deadline,
// kill the tree on timeout) with the same contract as spawnCaptured in process.ts. Where no worker
// can be started the caller runs the capture inline: slower for its thread, never a missing answer.
//
// ⛔ A CAPTURE THAT WAITED OUT ITS DEADLINE NEVER STARTS, AND THE ASKER IS ALWAYS ANSWERED (2026-10-11).
// One thread spawns every capture, so they queue behind each other's CreateProcess. From 06:10 to
// 08:00 UTC that queue held the CliMayte runner hand-off past the minute a runner gets to claim its
// spec (405 checks lost "never started", 80 workers failed "stopped three times"), and every
// climayte_run and climayte_status waited 150-1,600 s on a netstat behind it. So a capture that
// waited its whole `timeoutMs` for the thread is answered timedOut and never started (a backlog
// drains instead of growing); one that starts keeps its full `timeoutMs` from the spawn, as before
// (on this box a CreateProcess alone took 1.2-5.9 s that hour, so a deadline counted from the ask
// left a 3 s capture no time to print). The main thread answers by itself if the worker has not
// by 2 x `timeoutMs` + WORKER_GRACE_MS, whatever that thread is doing. A capture that must not wait
// behind the rest asks for a lane: a worker thread of its own.

export interface WorkerCapture {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

// killTree never waits for taskkill (2026-10-11): spawnSync held this one thread for each kill, so a
// burst of deadlines stopped it draining every other child, whose full pipes then blocked them past
// their own deadlines (70-90 netstat.exe hung under the daemon at once).
const WORKER_SOURCE = `
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      Bun.spawn(['taskkill', '/PID', String(pid), '/T', '/F'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {}
}
async function capture(cmd, opts) {
  let proc
  try {
    proc = Bun.spawn(cmd, {
      stdin: opts.stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    })
  } catch {
    return { code: null, stdout: '', stderr: '', timedOut: false }
  }
  if (opts.stdin !== undefined) {
    // Buffered by Bun, never awaited; an early exit closes the pipe under it (EPIPE), which the exit code reports.
    try {
      proc.stdin.write(opts.stdin)
      Promise.resolve(proc.stdin.end()).catch(() => {})
    } catch {}
  }
  const held = { stdout: '', stderr: '' }
  const drain = async (stream, into) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        held[into] += decoder.decode(value, { stream: true })
      }
      held[into] += decoder.decode()
    } catch {}
  }
  let timer
  let timedOut = false
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; if (proc.pid) killTree(proc.pid); resolve('timeout') }, opts.timeoutMs)
  })
  const work = Promise.all([drain(proc.stdout, 'stdout'), drain(proc.stderr, 'stderr')])
    .then(() => proc.exited).then((code) => ({ code }))
  const out = (code) => ({ code, stdout: held.stdout, stderr: opts.wantStderr ? held.stderr : '', timedOut })
  try {
    const settled = await Promise.race([work, deadline])
    if (settled === 'timeout') {
      await Promise.race([work, new Promise((r) => setTimeout(() => r(null), 2000))])
      return out(proc.exitCode)
    }
    return out(settled.code)
  } catch {
    return out(null)
  } finally {
    clearTimeout(timer)
    if (proc.exitCode === null && !proc.killed && proc.pid) killTree(proc.pid)
  }
}
self.onmessage = async (e) => {
  const { id, cmd, opts } = e.data
  // It waited its whole deadline for this thread: answered, never started.
  if (Date.now() - opts.askedAt >= opts.timeoutMs) {
    self.postMessage({ id, result: { code: null, stdout: '', stderr: '', timedOut: true } })
    return
  }
  self.postMessage({ id, result: await capture(cmd, opts) })
}
`

/** What the main thread allows past the worker's own worst case (a capture that waited just under
 *  its deadline, then ran its whole deadline) before answering by itself: the spawn (up to 5.9 s
 *  measured under load) and the 2 s the worker waits for a killed child's pipes (capture above). */
const WORKER_GRACE_MS = 10_000

const TIMED_OUT: WorkerCapture = { code: null, stdout: '', stderr: '', timedOut: true }

interface Pending {
  lane: string
  resolve: (r: WorkerCapture) => void
  reject: (err: Error) => void
  guard: ReturnType<typeof setTimeout>
}

const workers = new Map<string, Worker>()
const pending = new Map<number, Pending>()
let nextId = 0

function settle(id: number): Pending | undefined {
  const p = pending.get(id)
  if (!p) return undefined
  pending.delete(id)
  clearTimeout(p.guard)
  return p
}

function failLane(lane: string, err: Error): void {
  for (const [id, p] of pending) if (p.lane === lane) settle(id)?.reject(err)
}

function ensureWorker(lane: string): Worker {
  const live = workers.get(lane)
  if (live) return live
  const w = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })))
  // Never what keeps the process alive: a test run or one-shot CLI must be free to exit.
  // Bun's Worker has unref(); the DOM Worker type this file compiles against does not list it.
  ;(w as Worker & { unref(): void }).unref()
  w.onmessage = (e: MessageEvent<{ id: number; result: WorkerCapture }>) => {
    settle(e.data.id)?.resolve(e.data.result)
  }
  w.onerror = (e) => {
    // A dead worker fails what it held and is replaced on the next call.
    if (workers.get(lane) === w) workers.delete(lane)
    failLane(lane, new Error(`spawn worker failed: ${e.message}`))
    w.terminate()
  }
  workers.set(lane, w)
  return w
}

/** Run `cmd` on a worker thread: `lane`'s own, else the shared one. Answers within 2 x `timeoutMs` +
 *  WORKER_GRACE_MS whatever that thread is doing (timedOut when it could not say). Rejects when the
 *  worker cannot be used (not started, or died mid-run); the caller then runs the capture inline. A
 *  child's own failure is data, not a rejection. */
export function captureInWorker(
  cmd: string[],
  opts: {
    timeoutMs: number
    cwd?: string
    env?: Record<string, string | undefined>
    wantStderr: boolean
    stdin?: string
    lane?: string
  },
): Promise<WorkerCapture> {
  const { lane = 'shared', ...rest } = opts
  let w: Worker
  try {
    w = ensureWorker(lane)
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  const id = ++nextId
  return new Promise<WorkerCapture>((resolve, reject) => {
    const guard = setTimeout(
      () => settle(id)?.resolve({ ...TIMED_OUT }),
      2 * opts.timeoutMs + WORKER_GRACE_MS,
    )
    ;(guard as { unref?(): void }).unref?.()
    pending.set(id, { lane, resolve, reject, guard })
    try {
      w.postMessage({ id, cmd, opts: { ...rest, askedAt: Date.now() } })
    } catch (err) {
      settle(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// Routines (shared/routines.ts says what a routine is and what its file holds). GET /api/routines answers what its last look
// saw (?fresh=1 looks first); POST /api/routines does one action: run, pause, propose (any caller), resume, approve,
// discard (the window only), and turns the manager on or off with `enabled` (the window only). A look reads each routine's
// file, runs each status command, reads each Windows task in one call, judges (routines/decide.ts) and starts the runs that
// fell due. Its memory (each routine's last 30 runs, the one running, the newest slot it ran for, paused) is
// <home>/routines.json, so a restart keeps a prompt run it had not seen end and never starts a slot twice. A proposal
// (routines/proposed) is listed and never run. No model is asked here: a prompt routine is a Desk chat that runs its prompt.

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import {
  ROUTINES_EVERY_MS,
  type Routine,
  type RoutineDefinition,
  type RoutineOutcome,
  type RoutineProposal,
  type RoutineRun,
  type RoutinesRequest,
  type RoutinesStatus,
} from '@shared/routines'
import type { ServerContext } from '../context'
import { AsyncFile } from '../async-file'
import { bridge } from '../bridge'
import type { AhWorker, StartWorker } from '../bridge/client'
import { isActiveWorkerStatus } from '../bridge/climayte'
import { callerKind } from '../caller'
import { chatAddOns } from '../engine/desk-prompt'
import { emptyMemory, judge, lastEndOf, parseReading, slotsOf, type Memory, type Reading, type Seen } from '../routines/decide'
import { kindOf, parseProposalText, parseRoutineText, checkProposal, readEntries, ROUTINE_ID, TIMEOUT_DEFAULT, type Entry } from '../routines/manifest'
import { readTasks, runTaskNow, setTaskEnabled, TASK_NEVER_RAN, TASK_RUNNING, type TaskReading } from '../routines/wintask'

/** The first look after a start waits for the rest of Desk to come up. */
const FIRST_LOOK_MS = 60_000
/** While a prompt run is going, the manager looks this often to see whether its chat has ended. */
const PROMPT_LOOK_MS = 30_000
/** A status command has this long to print its object. */
const STATUS_MS = 60_000
/** Runs kept per routine. */
const RUNS_KEPT = 30
/** A run's log moves to <id>.log.1 once it passes this. */
const LOG_MAX_BYTES = 2 * 1024 * 1024
/** The exit code a busy routine answers with: its own lock is held by another run. */
const BUSY_EXIT = 75
/** Output kept to find a run's last line, and from a status command. */
const TAIL_CHARS = 4096
const STDOUT_CHARS = 1024 * 1024
const LINE_CHARS = 300
/** After SIGTERM, a process that has not ended gets SIGKILL this long later (not on Windows, where taskkill ends the tree). */
const GRACE_MS = 5_000
/** The actions a caller may ask for, one per call; and those only the window may ask for. */
const ACTIONS = ['run', 'pause', 'resume', 'approve', 'discard', 'propose'] as const
const OWNER_ACTIONS: readonly string[] = ['resume', 'approve', 'discard']
const OWNER_ONLY = { error: 'only the owner can do that, in Settings > Managers > Routines' }
const SHAPE =
  'the body must be JSON: { "enabled"?: true | false, "run"?: "<id>", "pause"?: "<id>", "resume"?: "<id>", "approve"?: "<id>", "discard"?: "<id>", "propose"?: { "id", "why", ...the contract } }, one action per call besides "enabled"'

/** How a worker stands now: the bridge's view of it. */
export type WorkerView = Pick<AhWorker, 'status' | 'error' | 'result' | 'sessionId'>

/** Desk's chats, as a routine's prompt run uses them. The default is AgentHydra's own bridge. */
export interface RoutineWorkers {
  start(task: StartWorker): Promise<{ id: string; sessionId: string | null }>
  read(id: string): Promise<WorkerView | null>
  cancel(id: string): Promise<void>
}

/** Windows' scheduled tasks, as a windowsTask routine uses them. The default is PowerShell and schtasks. */
export interface RoutineTasks {
  read(paths: string[]): Promise<TaskReading[]>
  run(path: string): Promise<void>
  setEnabled(path: string, enabled: boolean): Promise<void>
}

export interface RoutinesOptions {
  /** Test seam: scales every routine's timeout (its minutes times this). The server leaves it at 1. */
  timeoutScale?: number
  /** Test seam: the clock. The server leaves it at Date.now. */
  now?: () => number
  /** Test seam: the chats a prompt run uses. */
  workers?: RoutineWorkers
  /** Test seam: the Windows tasks a windowsTask routine uses. */
  tasks?: RoutineTasks
  /** Test seam: the platform a windowsTask routine needs. */
  platform?: NodeJS.Platform
}

const liveWorkers: RoutineWorkers = {
  start: (task) => bridge().startWorker(task),
  read: async (id) => (await bridge().workersByIds([id]))[0] ?? null,
  cancel: (id) => bridge().cancelWorker(id),
}

const liveTasks: RoutineTasks = { read: readTasks, run: runTaskNow, setEnabled: setTaskEnabled }

/** One run of a command: how it ended. */
interface Ran {
  code: number | null
  timedOut: boolean
  error: string | null
  stdout: string
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const pad = (n: number): string => String(n).padStart(2, '0')
/** A local time, YYYY-MM-DD HH:mm. */
const localStamp = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** A local time as the chat group's stamp, YYYYMMDDHHmm. */
const groupStamp = (ms: number): string => localStamp(ms).replace(/[-: ]/g, '')

/** <home>/routines.json, or empty memory when it is missing or damaged (a forgotten run only means a routine counts from zero). */
function load(file: string, now: number): Record<string, Memory> {
  let saved: { routines?: unknown } | null = null
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.error('[routines] routines.json did not load; starting with no memory:', err)
  }
  const routines = saved?.routines && typeof saved.routines === 'object' && !Array.isArray(saved.routines) ? (saved.routines as Record<string, Partial<Memory>>) : {}
  return Object.fromEntries(
    Object.entries(routines).map(([id, m]) => {
      const mem: Memory = {
        runs: Array.isArray(m?.runs) ? m.runs.slice(0, RUNS_KEPT) : [],
        running: null,
        lastSlot: typeof m?.lastSlot === 'number' ? m.lastSlot : null,
        paused: m?.paused === true,
      }
      // A command run still marked running when AgentHydra started again is gone: it is closed as interrupted. A prompt run
      // keeps its chat, which runs on, so the manager goes on watching it.
      if (m?.running && Number.isFinite(m.running.startedAt)) {
        const workerId = typeof m.running.workerId === 'string' ? m.running.workerId : null
        if (workerId) mem.running = { startedAt: m.running.startedAt, pid: null, workerId, sessionId: null }
        else {
          mem.runs.unshift({ startedAt: m.running.startedAt, endedAt: now, outcome: 'interrupted', exitCode: null, lastLine: 'AgentHydra restarted', workerId: null, sessionId: null })
          mem.runs.splice(RUNS_KEPT)
        }
      }
      return [id, mem]
    }),
  )
}

/** The last non-empty line of some output, cut to LINE_CHARS. */
function lastLineOf(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, LINE_CHARS)
}

function outcomeOf(r: Ran): RoutineOutcome {
  if (r.timedOut) return 'timed-out'
  if (r.error === null && r.code === 0) return 'ok'
  if (r.error === null && r.code === BUSY_EXIT) return 'busy'
  return 'failed'
}

/** Ends a process and what it started: taskkill's tree on Windows, else SIGTERM and then SIGKILL. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
    k.on('error', () => child.kill())
    return
  }
  child.kill('SIGTERM')
  const t = setTimeout(() => child.kill('SIGKILL'), GRACE_MS)
  ;(t as { unref?: () => void }).unref?.()
}

/** Runs an argv hidden, with no shell, until it ends or fails to start. `onStart` gets the child as it starts; `onOutput`
 *  sees each chunk of stdout and stderr; a run past `timeoutMs` is killed and reported as timed out. */
function run(
  argv: string[],
  o: { cwd?: string; timeoutMs: number; onStart?: (child: ChildProcess) => void; onOutput?: (text: string) => void },
): Promise<Ran> {
  return new Promise((resolve) => {
    let stdout = ''
    let timedOut = false
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: { code: number | null; error: string | null }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ...r, timedOut, stdout })
    }
    let child: ChildProcess
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: o.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch (err) {
      resolve({ code: null, timedOut: false, error: message(err), stdout: '' })
      return
    }
    o.onStart?.(child)
    timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, o.timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', (text: string) => {
      if (stdout.length < STDOUT_CHARS) stdout += text
      o.onOutput?.(text)
    })
    child.stderr?.setEncoding('utf8').on('data', (text: string) => o.onOutput?.(text))
    child.on('error', (err) => finish({ code: null, error: err.message }))
    child.on('close', (code) => finish({ code, error: null }))
  })
}

/** A routine's file body, as written: the contract without its id (the file name) and without `why`. */
function contractOf(def: RoutineDefinition | RoutineProposal): Record<string, unknown> {
  const body: Record<string, unknown> = { ...def }
  delete body.id
  return body
}

export default function plugin(app: Hono, ctx: ServerContext, opts: RoutinesOptions = {}): void {
  const routinesDir = join(ctx.home, 'routines')
  const proposedDir = join(routinesDir, 'proposed')
  const logsDir = join(routinesDir, 'logs')
  const file = join(ctx.home, 'routines.json')
  const writer = new AsyncFile(file)
  const timeoutScale = opts.timeoutScale ?? 1
  const clock = opts.now ?? Date.now
  const platform = opts.platform ?? process.platform
  const workers = opts.workers ?? liveWorkers
  const tasks = opts.tasks ?? liveTasks
  const memory = load(file, clock())
  let seen: Seen[] = []
  let proposals: RoutineProposal[] = []
  let checkedAt: number | null = null
  let nextCheckAt: number | null = null
  let lastError: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let looking: Promise<void> | null = null
  let stopping = false

  const enabled = (): boolean => ctx.settings().routines && !stopping
  /** A routine's memory. The first time it is seen, a schedule starts from its newest slot: a slot already past never runs. */
  const memOf = (entry: Entry, t: number): Memory => {
    memory[entry.id] ??= emptyMemory(entry.def?.schedule !== undefined ? (slotsOf(entry, t)?.newest ?? t) : null)
    return memory[entry.id]
  }

  function save(): void {
    writer.write(JSON.stringify({ routines: memory }))
  }

  /** A status command's reading, or why it did not read. A failure is its reason, never a guess. */
  async function readStatus(def: RoutineDefinition): Promise<{ reading: Reading | null; readError: string | null }> {
    if (!def.status) return { reading: null, readError: null }
    const unread = (readError: string): { reading: null; readError: string } => ({ reading: null, readError })
    const r = await run(def.status, { cwd: def.cwd, timeoutMs: STATUS_MS })
    if (r.timedOut) return unread('the status command timed out after 60 seconds')
    if (r.error !== null) return unread(`the status command could not start: ${r.error}`)
    if (r.code !== 0) return unread(`the status command exited ${r.code ?? 'without a code'}`)
    try {
      return { reading: parseReading(r.stdout), readError: null }
    } catch (err) {
      return unread(message(err))
    }
  }

  /** Records a run and keeps the newest RUNS_KEPT of them. */
  function finishRun(mem: Memory, r: RoutineRun): void {
    mem.runs.unshift(r)
    mem.runs.splice(RUNS_KEPT)
    mem.running = null
    save()
  }

  /** Starts a command run, hidden: its output goes to its log; when it ends, the run is kept and a status command is read again. */
  function startCommand(def: RoutineDefinition, mem: Memory, startedAt: number): void {
    mkdirSync(logsDir, { recursive: true })
    const log = join(logsDir, `${def.id}.log`)
    try {
      if (statSync(log).size > LOG_MAX_BYTES) renameSync(log, `${log}.1`)
    } catch {
      // No log yet.
    }
    const out = createWriteStream(log, { flags: 'a' })
    out.write(`\n--- ${new Date(startedAt).toISOString()} ---\n`)
    let tail = ''
    void run(def.run ?? [], {
      cwd: def.cwd,
      timeoutMs: (def.timeoutMinutes ?? TIMEOUT_DEFAULT) * 60_000 * timeoutScale,
      onStart: (child) => {
        mem.running = { startedAt, pid: child.pid ?? null, workerId: null, sessionId: null }
        save()
      },
      onOutput: (text) => {
        out.write(text)
        tail = (tail + text).slice(-TAIL_CHARS)
      },
    }).then(async (r) => {
      // The log is on disk before the run is recorded, so a run the page shows has its output.
      await new Promise<void>((done) => out.end(() => done()))
      finishRun(mem, { startedAt, endedAt: clock(), outcome: outcomeOf(r), exitCode: r.code, lastLine: lastLineOf(tail) || (r.error ?? ''), workerId: null, sessionId: null })
      if (def.status) {
        const fresh = await readStatus(def)
        seen = seen.map((s) => (s.entry.id === def.id ? { ...s, ...fresh } : s))
      }
    })
  }

  /** Starts a prompt run: a Desk chat, its prompt led by a short header that says whose routine it is and who asked for it. */
  async function startPrompt(def: RoutineDefinition, mem: Memory, startedAt: number): Promise<void> {
    const header = `This is the routine "${def.name}" run by AgentHydra's routine manager at ${localStamp(startedAt)}; asked for by ${def.askedBy}. Do exactly what it says; never create, change, pause or schedule any routine or scheduled task.`
    try {
      const w = await workers.start({
        prompt: `${header}\n\n${def.prompt ?? ''}`,
        cwd: def.cwd ?? '',
        title: `Routine: ${def.name}`,
        group: `routine-${def.id}-${groupStamp(startedAt)}`,
        desk: chatAddOns(def.cwd ?? '', false),
      })
      mem.running = { startedAt, pid: null, workerId: w.id, sessionId: w.sessionId }
      save()
    } catch (err) {
      finishRun(mem, { startedAt, endedAt: clock(), outcome: 'failed', exitCode: null, lastLine: message(err).slice(0, LINE_CHARS), workerId: null, sessionId: null })
    }
  }

  /** Starts one run of a routine now. The run is marked running before anything waits, so no second run starts meanwhile. */
  function startRun(def: RoutineDefinition, mem: Memory, slot: number | null, t: number): void {
    mem.running = { startedAt: t, pid: null, workerId: null, sessionId: null }
    if (slot !== null) mem.lastSlot = slot
    save()
    if (def.prompt !== undefined) void startPrompt(def, mem, t)
    else startCommand(def, mem, t)
  }

  /** The prompt runs going on: each whose chat has ended is recorded; each past its timeout is cancelled and recorded. */
  async function pollPrompts(t: number): Promise<void> {
    for (const [id, mem] of Object.entries(memory)) {
      const running = mem.running
      if (!running?.workerId) continue
      const workerId = running.workerId
      const minutes = seen.find((s) => s.entry.id === id)?.entry.def?.timeoutMinutes ?? TIMEOUT_DEFAULT
      let w: WorkerView | null
      try {
        w = await workers.read(workerId)
      } catch {
        continue
      }
      if (w && isActiveWorkerStatus(w.status)) {
        if (t - running.startedAt < minutes * 60_000 * timeoutScale) continue
        await workers.cancel(workerId).catch(() => undefined)
        finishRun(mem, { startedAt: running.startedAt, endedAt: clock(), outcome: 'timed-out', exitCode: null, lastLine: `timed out after ${minutes} minutes`, workerId, sessionId: running.sessionId })
        continue
      }
      const failed = !w || w.error !== null || /fail|cancel|stop|error/.test(w.status)
      const last = w ? lastLineOf(w.result ?? w.error ?? '') || w.status : 'its chat is gone'
      finishRun(mem, { startedAt: running.startedAt, endedAt: clock(), outcome: failed ? 'failed' : 'ok', exitCode: null, lastLine: last.slice(0, LINE_CHARS), workerId, sessionId: w?.sessionId ?? running.sessionId })
    }
  }

  /** A Windows task's last run, recorded once when it is newer than the newest one kept. Still running, or never ran: nothing. */
  function recordTaskRun(s: Seen, mem: Memory, t: number): void {
    const task = s.task
    if (!task?.found || task.lastRunAt === null || task.lastTaskResult === null) return
    if (task.lastTaskResult === TASK_RUNNING || task.lastTaskResult === TASK_NEVER_RAN) return
    if (mem.runs[0] && task.lastRunAt <= mem.runs[0].startedAt) return
    const code = task.lastTaskResult
    mem.runs.unshift({ startedAt: task.lastRunAt, endedAt: t, outcome: code === 0 ? 'ok' : 'failed', exitCode: code, lastLine: `Windows task result ${code}`, workerId: null, sessionId: null })
    mem.runs.splice(RUNS_KEPT)
    save()
  }

  /** Reads each routine's file, status and Windows task. A windowsTask routine off Windows is broken; the tasks are read in one call. */
  async function readAll(): Promise<{ seen: Seen[]; proposals: RoutineProposal[] }> {
    const entries = readEntries(routinesDir, parseRoutineText).map((e): Entry => {
      if (e.def?.windowsTask !== undefined && platform !== 'win32') return { id: e.id, def: null, broken: 'a Windows task runs only on Windows' }
      return e
    })
    const names = [...new Set(entries.flatMap((e) => (e.def?.windowsTask !== undefined ? [e.def.windowsTask] : [])))]
    let readings: TaskReading[] = []
    let taskError: string | null = null
    if (names.length) {
      try {
        readings = await tasks.read(names)
      } catch (err) {
        taskError = `Windows could not read its tasks: ${message(err)}`
      }
    }
    const reads = await Promise.all(
      entries.map(async (entry): Promise<Seen> => {
        const path = entry.def?.windowsTask
        if (path !== undefined) return { entry, reading: null, readError: taskError, task: readings.find((r) => r.path === path) ?? null }
        const status = entry.def ? await readStatus(entry.def) : { reading: null, readError: null }
        return { entry, reading: status.reading, readError: status.readError, task: null }
      }),
    )
    const found = readEntries(proposedDir, parseProposalText).flatMap((e) => (e.def ? [e.def] : []))
    return { seen: reads, proposals: found }
  }

  /** One look: reads everything, judges, and starts the runs that fell due. One look at a time. */
  function look(): Promise<void> {
    looking ??= (async () => {
      try {
        const t = clock()
        await pollPrompts(t)
        const read = await readAll()
        seen = read.seen
        proposals = read.proposals
        lastError = null
        checkedAt = t
        for (const s of seen) {
          const mem = memOf(s.entry, t)
          recordTaskRun(s, mem, t)
          const j = judge(s, mem, t, enabled(), false)
          if (j.skipSlot !== null) mem.lastSlot = j.skipSlot
          if (j.start && s.entry.def) startRun(s.entry.def, mem, j.slot, t)
        }
        save()
      } catch (err) {
        lastError = `the last look failed: ${message(err)}`
        console.error('[routines] look failed:', err)
      } finally {
        schedule()
      }
    })().finally(() => (looking = null))
    return looking
  }

  /** The next look: in ROUTINES_EVERY_MS, or sooner for the earliest schedule slot (+1 s) or a prompt run being watched. */
  function schedule(delay?: number): void {
    clearTimeout(timer)
    timer = undefined
    nextCheckAt = null
    if (stopping) return
    const t = clock()
    let wait = delay ?? ROUTINES_EVERY_MS
    if (delay === undefined) {
      for (const s of seen) {
        const next = slotsOf(s.entry, t)?.next
        if (next !== null && next !== undefined) wait = Math.min(wait, next - t + 1000)
      }
      if (Object.values(memory).some((m) => m.running?.workerId)) wait = Math.min(wait, PROMPT_LOOK_MS)
    }
    wait = Math.max(wait, 1000)
    nextCheckAt = t + wait
    timer = setTimeout(() => void look(), wait)
    // A look never keeps the process alive: Desk stopping stops it.
    ;(timer as { unref?: () => void }).unref?.()
  }

  function routineView(s: Seen, t: number): Routine {
    const { entry } = s
    const def = entry.def
    const mem = memory[entry.id] ?? emptyMemory()
    const j = judge(s, mem, t, enabled(), false)
    return {
      id: entry.id,
      name: def?.name ?? entry.id,
      kind: def ? kindOf(def) : null,
      state: j.state,
      reason: j.reason,
      askedBy: def?.askedBy ?? null,
      schedule: def?.schedule ?? null,
      windowsTask: def?.windowsTask ?? null,
      what: def?.run !== undefined ? 'run' : def?.prompt !== undefined ? 'prompt' : null,
      cwd: def?.cwd ?? null,
      timeoutMinutes: def?.timeoutMinutes ?? null,
      until: def?.until ?? null,
      paused: def?.windowsTask !== undefined ? s.task?.state === 'Disabled' : mem.paused,
      headline: s.reading?.headline ?? null,
      totals: s.reading?.totals ?? null,
      settings: s.reading?.settings ?? null,
      lastRunAt: def?.windowsTask !== undefined ? (mem.runs[0]?.endedAt ?? null) : lastEndOf(s.reading, mem),
      nextRunAt: j.nextRunAt,
      running: mem.running ? { ...mem.running } : null,
      runs: [...mem.runs],
    }
  }

  function status(): RoutinesStatus {
    const t = clock()
    return { enabled: enabled(), everyMs: ROUTINES_EVERY_MS, checkedAt, nextCheckAt, routines: seen.map((s) => routineView(s, t)), proposals, error: lastError }
  }

  ctx.onStop(() => {
    stopping = true
    clearTimeout(timer)
    timer = undefined
    // A running run is not killed: a prompt run's chat runs on, and a command's own lock stops a second one.
    writer.flushSync()
  })

  app.get('/api/routines', async (c) => {
    if (checkedAt === null || c.req.query('fresh') === '1') await look()
    return c.json(status())
  })

  app.post('/api/routines', async (c) => {
    const body = (await c.req.json().catch(() => null)) as RoutinesRequest | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: SHAPE }, 400)
    const actions = ACTIONS.filter((k) => body[k] !== undefined)
    const typed = actions.every((k) => (k === 'propose' ? typeof body.propose === 'object' && body.propose !== null : typeof body[k] === 'string'))
    if (
      (body.enabled !== undefined && typeof body.enabled !== 'boolean') ||
      actions.length > 1 ||
      (actions.length === 0 && body.enabled === undefined) ||
      !typed
    )
      return c.json({ error: SHAPE }, 400)
    const owner = callerKind(c.req.raw.headers) === 'window'
    const [action] = actions
    if (body.enabled !== undefined && !owner) return c.json(OWNER_ONLY, 403)
    if (action !== undefined && OWNER_ACTIONS.includes(action) && !owner) return c.json(OWNER_ONLY, 403)
    const id = action === 'propose' ? '' : (body[action as 'run'] ?? '')
    if (action !== undefined && action !== 'propose' && !ROUTINE_ID.test(id)) return c.json({ error: `"${id}" is not a routine id` }, 400)

    if (body.enabled !== undefined && body.enabled !== ctx.settings().routines) ctx.updateSettings({ routines: body.enabled })
    if (body.enabled === true) await look()
    if (action === undefined) return c.json(status())

    const t = clock()
    if (action === 'run') {
      await look()
      const s = seen.find((x) => x.entry.id === id)
      if (!s) return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing` }, 404)
      const def = s.entry.def
      const mem = memOf(s.entry, t)
      if (def?.windowsTask !== undefined) {
        const j = judge(s, mem, t, enabled(), false)
        if (j.state !== 'idle') return c.json({ error: `"${id}" is ${j.state}: ${j.reason}` }, 409)
        try {
          await tasks.run(def.windowsTask)
        } catch (err) {
          return c.json({ error: `Windows refused to run "${id}": ${message(err)}` }, 500)
        }
        await look()
        return c.json(status())
      }
      const j = judge(s, mem, t, enabled(), true)
      if (!j.start || !def) return c.json({ error: `"${id}" is ${j.state}: ${j.reason}` }, 409)
      startRun(def, mem, null, t)
      return c.json(status())
    }

    if (action === 'pause' || action === 'resume') {
      const s = seen.find((x) => x.entry.id === id)
      if (!s) return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing` }, 404)
      const path = s.entry.def?.windowsTask
      if (path !== undefined) {
        try {
          await tasks.setEnabled(path, action === 'resume')
        } catch (err) {
          return c.json({ error: `Windows refused to ${action} "${id}": ${message(err)}` }, 500)
        }
      } else {
        memOf(s.entry, t).paused = action === 'pause'
        save()
      }
      await look()
      return c.json(status())
    }

    if (action === 'propose') {
      const raw = body.propose as unknown as Record<string, unknown>
      const pid = typeof raw.id === 'string' ? raw.id : ''
      let proposal: RoutineProposal
      try {
        const rest = { ...raw }
        delete rest.id
        proposal = checkProposal(pid, rest)
      } catch (err) {
        return c.json({ error: `the proposal is refused: ${message(err)}` }, 400)
      }
      if (existsSync(join(routinesDir, `${pid}.json`)) || existsSync(join(proposedDir, `${pid}.json`)))
        return c.json({ error: `"${pid}" already exists as a routine or a proposal` }, 409)
      mkdirSync(proposedDir, { recursive: true })
      writeFileSync(join(proposedDir, `${pid}.json`), `${JSON.stringify(contractOf(proposal), null, 2)}\n`)
      await look()
      return c.json(status())
    }

    // approve and discard: the window only (checked above). Each acts on the proposal file of that id.
    const proposal = join(proposedDir, `${id}.json`)
    if (!existsSync(proposal)) return c.json({ error: `no proposal "${id}" is waiting` }, 404)
    if (action === 'discard') {
      rmSync(proposal, { force: true })
      await look()
      return c.json(status())
    }
    if (existsSync(join(routinesDir, `${id}.json`))) return c.json({ error: `a routine "${id}" already exists` }, 409)
    let approved: RoutineProposal
    try {
      approved = parseProposalText(id, readFileSync(proposal, 'utf8'))
    } catch (err) {
      return c.json({ error: `the proposal does not check out: ${message(err)}` }, 400)
    }
    const body2 = contractOf(approved)
    delete body2.why
    writeFileSync(join(routinesDir, `${id}.json`), `${JSON.stringify(body2, null, 2)}\n`)
    rmSync(proposal, { force: true })
    await look()
    return c.json(status())
  })

  // The first look waits for the rest of Desk to come up.
  schedule(FIRST_LOOK_MS)
}

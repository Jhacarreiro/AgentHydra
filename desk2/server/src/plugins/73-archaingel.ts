// ArchAIngel (shared/archaingel.ts says what it is for and what an agent's files say). GET /api/archaingel answers what
// its last look saw (?fresh=1 looks first); POST /api/archaingel { enabled?, run? } turns it on or off (Settings'
// `archaingel`, on by default) and/or ticks one agent now. A look reads each registered agent's manifest, runs its status
// command, judges (archaingel/decide.ts) and starts the ticks that fell due: each one hidden, one at a time per agent,
// killed when it runs past its timeout. Its memory (each agent's last 30 ticks and the one running) is
// <home>/archaingel.json, so a restart closes a tick it had not seen end as 'interrupted' and never starts one twice.
// No model is asked: a look costs a few local reads and each agent's own command.

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import {
  ARCHAINGEL_EVERY_MS,
  type ArchAIngelAgent,
  type ArchAIngelOutcome,
  type ArchAIngelRequest,
  type ArchAIngelStatus,
} from '@shared/archaingel'
import type { ServerContext } from '../context'
import { AsyncFile } from '../async-file'
import { emptyMemory, judge, lastEndOf, parseReading, type Memory, type Seen } from '../archaingel/decide'
import { readEntries, type Entry, type Manifest } from '../archaingel/manifest'

/** The first look after a start waits for the rest of Desk to come up. */
const FIRST_LOOK_MS = 60_000
/** A status command has this long to print its object. */
const STATUS_MS = 60_000
/** Runs kept per agent. */
const RUNS_KEPT = 30
/** A tick's log moves to <id>.log.1 once it passes this. */
const LOG_MAX_BYTES = 2 * 1024 * 1024
/** The exit code a busy agent answers with: its own lock is held by another run. */
const BUSY_EXIT = 75
/** Output kept to find a tick's last line, and from a status command. */
const TAIL_CHARS = 4096
const STDOUT_CHARS = 1024 * 1024
const LINE_CHARS = 300
/** After SIGTERM, a process that has not ended gets SIGKILL this long later (not on Windows, where taskkill ends the tree). */
const GRACE_MS = 5_000

export interface ArchAIngelOptions {
  /** Test seam: scales every agent's timeout (its minutes times this). The server leaves it at 1. */
  timeoutScale?: number
}

/** One run of a command: how it ended. */
interface Ran {
  code: number | null
  timedOut: boolean
  error: string | null
  stdout: string
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** <home>/archaingel.json, or empty memory when it is missing or damaged (a forgotten tick only means an agent counts from zero). */
function load(file: string, now: number): Record<string, Memory> {
  let saved: { agents?: unknown } | null = null
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.error('[archaingel] archaingel.json did not load; starting with no memory:', err)
  }
  const agents = saved?.agents && typeof saved.agents === 'object' && !Array.isArray(saved.agents) ? (saved.agents as Record<string, Partial<Memory>>) : {}
  return Object.fromEntries(
    Object.entries(agents).map(([id, m]) => {
      const mem: Memory = { runs: Array.isArray(m?.runs) ? m.runs.slice(0, RUNS_KEPT) : [], running: null }
      // A tick still marked running when AgentHydra started again is gone: it is closed as interrupted.
      if (m?.running && Number.isFinite(m.running.startedAt)) {
        mem.runs.unshift({ startedAt: m.running.startedAt, endedAt: now, outcome: 'interrupted', exitCode: null, lastLine: 'AgentHydra restarted' })
        mem.runs.splice(RUNS_KEPT)
      }
      return [id, mem]
    }),
  )
}

/** The last non-empty line of some output, cut to LINE_CHARS. */
function lastLineOf(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, LINE_CHARS)
}

function outcomeOf(r: Ran): ArchAIngelOutcome {
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

export default function plugin(app: Hono, ctx: ServerContext, opts: ArchAIngelOptions = {}): void {
  const agentsDir = join(ctx.home, 'archaingel', 'agents')
  const logsDir = join(ctx.home, 'archaingel', 'logs')
  const file = join(ctx.home, 'archaingel.json')
  const writer = new AsyncFile(file)
  const timeoutScale = opts.timeoutScale ?? 1
  const memory = load(file, Date.now())
  let seen: Seen[] = []
  let checkedAt: number | null = null
  let nextCheckAt: number | null = null
  let lastError: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let looking: Promise<void> | null = null
  let stopping = false

  const enabled = (): boolean => ctx.settings().archaingel && !stopping
  const memOf = (id: string): Memory => (memory[id] ??= emptyMemory())

  function save(): void {
    writer.write(JSON.stringify({ agents: memory }))
  }

  /** Runs an agent's status command and reads what it printed. A failure is its reason, never a guess. */
  async function readSeen(entry: Entry): Promise<Seen> {
    const unread = (readError: string): Seen => ({ entry, reading: null, readError })
    if (!entry.manifest) return unread('its manifest is broken')
    const r = await run(entry.manifest.status, { cwd: entry.manifest.cwd, timeoutMs: STATUS_MS })
    if (r.timedOut) return unread('the status command timed out after 60 seconds')
    if (r.error !== null) return unread(`the status command could not start: ${r.error}`)
    if (r.code !== 0) return unread(`the status command exited ${r.code ?? 'without a code'}`)
    try {
      return { entry, reading: parseReading(r.stdout), readError: null }
    } catch (err) {
      return unread(message(err))
    }
  }

  /** Starts one tick of an agent, hidden. Its output goes to its log; when it ends, its run is kept and its status read again. */
  function startTick(m: Manifest): void {
    const mem = memOf(m.id)
    const startedAt = Date.now()
    mkdirSync(logsDir, { recursive: true })
    const log = join(logsDir, `${m.id}.log`)
    try {
      if (statSync(log).size > LOG_MAX_BYTES) renameSync(log, `${log}.1`)
    } catch {
      // No log yet.
    }
    const out = createWriteStream(log, { flags: 'a' })
    out.write(`\n--- ${new Date(startedAt).toISOString()} ---\n`)
    let tail = ''
    void run(m.tick, {
      cwd: m.cwd,
      timeoutMs: m.timeoutMinutes * 60_000 * timeoutScale,
      onStart: (child) => {
        mem.running = { startedAt, pid: child.pid ?? null }
        save()
      },
      onOutput: (text) => {
        out.write(text)
        tail = (tail + text).slice(-TAIL_CHARS)
      },
    }).then(async (r) => {
      // The log is on disk before the run is recorded, so a run the page shows has its output.
      await new Promise<void>((done) => out.end(() => done()))
      mem.runs.unshift({ startedAt, endedAt: Date.now(), outcome: outcomeOf(r), exitCode: r.code, lastLine: lastLineOf(tail) || (r.error ?? '') })
      mem.runs.splice(RUNS_KEPT)
      mem.running = null
      save()
      const fresh = await readSeen({ id: m.id, manifest: m, broken: null })
      seen = seen.map((s) => (s.entry.id === m.id ? fresh : s))
    })
  }

  /** One look: reads every agent's status, judges, and starts the ticks that fell due. One look at a time. */
  function look(): Promise<void> {
    looking ??= (async () => {
      try {
        const reads = await Promise.all(readEntries(agentsDir).map(readSeen))
        const now = Date.now()
        seen = reads
        lastError = null
        checkedAt = now
        for (const s of reads) {
          if (s.entry.manifest && judge(s, memOf(s.entry.id), now, enabled(), false).start) startTick(s.entry.manifest)
        }
        save()
      } catch (err) {
        lastError = `the last look failed: ${message(err)}`
        console.error('[archaingel] look failed:', err)
      } finally {
        schedule()
      }
    })().finally(() => (looking = null))
    return looking
  }

  /** The next look: in ARCHAINGEL_EVERY_MS. It looks while off too, starting nothing, so the page stays current. */
  function schedule(delay = ARCHAINGEL_EVERY_MS): void {
    clearTimeout(timer)
    timer = undefined
    nextCheckAt = null
    if (stopping) return
    nextCheckAt = Date.now() + delay
    timer = setTimeout(() => void look(), delay)
    // A look never keeps the process alive: Desk stopping stops it.
    ;(timer as { unref?: () => void }).unref?.()
  }

  function agentView(s: Seen, now: number): ArchAIngelAgent {
    const id = s.entry.id
    const mem = memOf(id)
    const j = judge(s, mem, now, enabled(), false)
    return {
      id,
      name: s.entry.manifest?.name ?? id,
      state: j.state,
      reason: j.reason,
      headline: s.reading?.headline ?? null,
      totals: s.reading?.totals ?? null,
      settings: s.reading?.settings ?? null,
      lastTickAt: lastEndOf(s.reading, mem),
      nextTickAt: s.reading?.nextTickAt ?? null,
      running: mem.running ? { ...mem.running } : null,
      runs: [...mem.runs],
    }
  }

  function status(): ArchAIngelStatus {
    const now = Date.now()
    return { enabled: enabled(), everyMs: ARCHAINGEL_EVERY_MS, checkedAt, nextCheckAt, agents: seen.map((s) => agentView(s, now)), error: lastError }
  }

  ctx.onStop(() => {
    stopping = true
    clearTimeout(timer)
    timer = undefined
    // A running tick is not killed: the agent's own lock stops a second one.
    writer.flushSync()
  })

  app.get('/api/archaingel', async (c) => {
    if (checkedAt === null || c.req.query('fresh') === '1') await look()
    return c.json(status())
  })

  app.post('/api/archaingel', async (c) => {
    const body = (await c.req.json().catch(() => null)) as ArchAIngelRequest | null
    if (!body || (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.run !== undefined && typeof body.run !== 'string'))
      return c.json({ error: 'the body must be JSON: { "enabled"?: true | false, "run"?: "<agent id>" }' }, 400)
    if (body.enabled !== undefined && body.enabled !== ctx.settings().archaingel) ctx.updateSettings({ archaingel: body.enabled })
    if (body.enabled === true || body.run !== undefined) await look()
    if (body.run !== undefined) {
      const s = seen.find((x) => x.entry.id === body.run)
      if (!s) return c.json({ error: `no agent "${body.run}" is registered: archaingel/agents/${body.run}.json is missing` }, 404)
      const j = judge(s, memOf(s.entry.id), Date.now(), enabled(), true)
      if (!j.start || !s.entry.manifest) return c.json({ error: `"${body.run}" is ${j.state}: ${j.reason}` }, 409)
      startTick(s.entry.manifest)
    }
    return c.json(status())
  })

  // The first look waits for the rest of Desk to come up.
  schedule(FIRST_LOOK_MS)
}

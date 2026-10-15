// Routines (shared/routines.ts says what a routine is and what its file holds). GET /api/routines answers what its last look
// saw (?fresh=1 looks first); POST /api/routines does one action: run, pause, propose (any caller), resume, approve,
// discard (the window only), and turns the manager on or off with `enabled` (the window only). A look reads each routine's
// file, runs each status command, reads each Windows task in one call, judges (routines/decide.ts) and starts the runs that
// fell due. Its memory (each routine's last 30 runs, the one running, the newest slot it ran for, paused) is
// <home>/routines.json, so a restart goes on watching a run it had not seen end (a command run's runner, routines/runner.ts,
// and a prompt run's chat both outlive Desk) and never starts a slot twice. A proposal (routines/proposed) is listed and
// never run. No model decides here: a prompt routine is a Desk chat that runs its prompt, and a routine whose file says
// `describe` has each run's output read by one Haiku turn afterwards (routines/describe.ts), kept with the run.

import type { Hono } from 'hono'
import { join, resolve } from 'node:path'
import type { ServerContext } from '../context'
import { AsyncFile } from '../async-file'
import { bridge } from '../bridge'
import { claudeCodeBinaryFor } from '../engine/claude-code-binary'
import { sdkDescriber } from '../routines/describe'
import { ROUTINE_ID } from '../routines/manifest'
import { FIRST_LOOK_MS, liveIncidents, liveTasks, liveWorkers, type RoutinesOptions } from '../routines/manager-config'
import { postRoutine } from '../routines/manager-actions'
import { schedule } from '../routines/manager-look'
import { load } from '../routines/manager-files'
import type { Manager } from '../routines/manager'
import { detailsFor, readRoutines } from '../routines/manager-view'

export type { RoutineIncidents, RoutineTasks, RoutineWorkers, RoutinesOptions, WorkerView } from '../routines/manager-config'

export default function plugin(app: Hono, ctx: ServerContext, opts: RoutinesOptions = {}): void {
  // Absolute: the runner WMI starts sits in system32, and reads these paths from there.
  const routinesDir = resolve(ctx.home, 'routines')
  const file = join(ctx.home, 'routines.json')
  const writer = new AsyncFile(file)
  const describer = opts.describer ?? sdkDescriber(ctx.home, () => bridge().listAccounts(), () => claudeCodeBinaryFor(ctx.home).path())
  const m: Manager = {
    ctx,
    routinesDir,
    proposedDir: join(routinesDir, 'proposed'),
    logsDir: join(routinesDir, 'logs'),
    runsDir: join(routinesDir, 'runs'),
    historyDir: join(routinesDir, 'history'),
    writer,
    timeoutScale: opts.timeoutScale ?? 1,
    clock: opts.now ?? Date.now,
    platform: opts.platform ?? process.platform,
    workers: opts.workers ?? liveWorkers,
    incidents: opts.incidents ?? liveIncidents,
    tasks: opts.tasks ?? liveTasks,
    describer,
    memory: load(file),
    reportedBroken: new Set<string>(),
    startingPrompts: new Set<string>(),
    runCounts: new Map<string, number>(),
    settling: null,
    seen: [],
    proposals: [],
    checkedAt: null,
    nextCheckAt: null,
    lastError: null,
    timer: undefined,
    looking: null,
    stopping: false,
  }

  ctx.onStop(async () => {
    m.stopping = true
    clearTimeout(m.timer)
    m.timer = undefined
    // A running run is not killed: a prompt run's chat runs on, and a command run's runner is outside Desk's tree.
    m.writer.flushSync()
    // A write already under way finishes, so it leaves no temp file behind.
    await m.writer.quiet()
  })

  app.get('/api/routines/:id/details', (c) => {
    const id = c.req.param('id')
    const details = ROUTINE_ID.test(id) ? detailsFor(m, id, c.req.query('before'), c.req.query('limit')) : null
    return details ? c.json(details) : c.json({ error: 'no such routine' }, 404)
  })

  app.get('/api/routines', async (c) => c.json(await readRoutines(m, c.req.query('fresh') === '1')))

  app.post('/api/routines', (c) => postRoutine(m, c))

  // The first look waits for the rest of Desk to come up.
  schedule(m, FIRST_LOOK_MS)
}

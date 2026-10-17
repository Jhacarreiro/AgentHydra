// server/tests/orchestrator-move-outlives-daemon.test.ts: a run that acts on chats at length outlives
// the daemon that started it, and the next daemon answers its operation id with the run's real result.
//
// WHY (2026-10-08, 2026-10-17): such a run was the daemon's own child, Bun ends its children when it
// exits, and a restart 23 minutes into a 9-chat migrate_batch left two chats on both accounts and
// seven never tried; from then on every restart was refused while a move ran. Here a real bun process
// plays the daemon: it starts an operation on a stub toolbox whose script is still waiting when that
// process exits. The script must finish anyway, and this process, playing the next daemon, takes the
// operation on from its files and answers it under the same id.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptOrchestratorRuns,
  getOrchestratorOperation,
  type OrchestratorRun,
  resetOrchestratorOperationsForTests,
} from '../src/orchestrator'

const ROOT = mkdtempSync(join(tmpdir(), 'orch-run-daemon-'))
const DIR = join(ROOT, 'toolbox')
afterAll(() => {
  resetOrchestratorOperationsForTests()
  rmSync(ROOT, { recursive: true, force: true })
})

// orch.py as the driver is called: `orch.py <script> ... --marker <path>`. It says it started, waits
// for this test's go (written only once the daemon that started it is gone and its run is taken on),
// then writes the marker and its verdict line. A go that never comes ends it in 90 s.
const STUB_ORCH = `import pathlib, sys, time
marker = pathlib.Path(sys.argv[sys.argv.index("--marker") + 1])
pathlib.Path(str(marker) + ".started").write_text("1")
go = pathlib.Path(str(marker) + ".go")
until = time.monotonic() + 90
while not go.exists():
    if time.monotonic() > until:
        sys.exit(3)
    time.sleep(0.1)
marker.write_text("acted")
print(sys.argv[1] + " finished: example chat", flush=True)
`
await Bun.write(join(DIR, 'orch.py'), STUB_ORCH)

/** Run the daemon fixture to its exit: its exit code and the ids it printed. */
async function daemonThatExits(
  marker: string,
  script: string,
  extra: string[],
  then = 'exit',
): Promise<string[]> {
  const daemon = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures', 'orchestrator-move-daemon.ts'),
      DIR,
      marker,
      script,
      JSON.stringify(extra),
      then,
    ],
    // The preload's scratch state is in process.env, which Bun.spawn does not pass unless told.
    { env: process.env, stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  const exited = await daemon.exited
  expect(exited, await new Response(daemon.stderr).text()).toBe(0)
  return (await new Response(daemon.stdout).text()).trim().split(/\r?\n/)
}

async function settled(id: string) {
  const until = Date.now() + 60_000
  while (getOrchestratorOperation(id)?.status === 'running' && Date.now() < until)
    await Bun.sleep(200)
  return getOrchestratorOperation(id)
}

// One row per kind of run under a runner (orchestrator.ts outlivesDaemon). Each failed on the code
// before it was added, the run dying with the daemon and leaving no record to adopt: the two moves
// in 22196df8 and PR #14, then on 2026-10-17 the archiving sweep (its lane plus the doctrine pass
// over every chat) and the fan_out spawn, which takes 50 s per chat.
const RUNS: Array<[string, string, string[]]> = [
  ['a chat move', 'migrate_chat', []],
  ['a chats --move-to run', 'chats', ['--move-to', 'example-account', '--yes']],
  ['an archiving sweep', 'sweep', ['--archive', '--yes']],
  ['a fan_out spawn', 'fan_out', ['--spec', '{"tasks": []}', '--group-id', 'fo-example', '--json']],
]

test.each(RUNS)(
  '%s started by a daemon that exits finishes, and the next daemon answers its id with the result',
  async (_kind, script, extra) => {
    const marker = join(ROOT, `marker-${script}`)
    const [id = ''] = await daemonThatExits(marker, script, extra)
    // The daemon is gone and the run is still under way.
    expect(existsSync(`${marker}.started`)).toBe(true)
    expect(existsSync(marker)).toBe(false)

    expect(await adoptOrchestratorRuns()).toBeGreaterThanOrEqual(1)
    expect(getOrchestratorOperation(id)?.status).toBe('running')
    writeFileSync(`${marker}.go`, '')

    const op = await settled(id)
    expect(op?.status).toBe('done')
    const run = op?.result as OrchestratorRun
    expect(run.exitCode).toBe(0)
    expect(run.script).toBe(script)
    expect(run.stdout).toContain(`${script} finished: example chat`)
    expect(readFileSync(marker, 'utf8')).toBe('acted')
  },
  120_000,
)

// WHY (2026-10-17): the record kept the operation and its run but not that a cancel was asked, so a
// daemon that exited after ending the runner and before reading that end left the next daemon
// reading `failed` ("its runner ended without writing an exit") for a run a person had cancelled.
test('a cancel asked just before its daemon exits still reads cancelled on the next daemon', async () => {
  const marker = join(ROOT, 'marker-cancel')
  const [id = ''] = await daemonThatExits(marker, 'migrate_chat', [], 'cancel')

  expect(await adoptOrchestratorRuns()).toBeGreaterThanOrEqual(1)
  const op = await settled(id)
  expect(op?.status).toBe('cancelled')
  expect(existsSync(marker)).toBe(false)
}, 120_000)

// WHY (2026-10-17): a run that took the route from another (a person's --terminate-live, see
// mayPreempt) names it in its result, and that name lived only in the daemon that started it; the
// next daemon answered the same run with no `preempted`, so nobody could tell what it had replaced.
test('a run that preempted another still names it when the next daemon answers it', async () => {
  const marker = join(ROOT, 'marker-preempt')
  const [id = '', holder = ''] = await daemonThatExits(
    marker,
    'migrate_chat',
    ['--chat', 'example chat'],
    'preempt',
  )
  expect(holder).not.toBe('')

  expect(await adoptOrchestratorRuns()).toBeGreaterThanOrEqual(1)
  writeFileSync(`${marker}.go`, '')
  const op = await settled(id)
  expect(op?.status).toBe('done')
  expect((op?.result as OrchestratorRun | undefined)?.preempted).toBe(holder)
  // The holder never got its go: the preemption ended it before it wrote anything.
  expect(existsSync(`${marker}.holder`)).toBe(false)
}, 120_000)

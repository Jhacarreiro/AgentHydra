// server/tests/orchestrator-move-outlives-daemon.test.ts: a chat move outlives the daemon that
// started it, and the next daemon answers its operation id with the move's real result.
//
// WHY (2026-10-08, 2026-10-17): a move ran as the daemon's own child, Bun ends its children when it
// exits, and a restart 23 minutes into a 9-chat migrate_batch left two chats on both accounts and
// seven never tried; from then on every restart was refused while a move ran. Here a real bun
// process plays the daemon: it starts a migrate_chat operation on a stub toolbox whose script is
// still sleeping when that process exits. The script must finish anyway, and this process, playing
// the next daemon, takes the operation on from its files and answers it under the same id.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptOrchestratorRuns,
  getOrchestratorOperation,
  type OrchestratorRun,
  resetOrchestratorOperationsForTests,
} from '../src/orchestrator'

const ROOT = mkdtempSync(join(tmpdir(), 'orch-move-daemon-'))
afterAll(() => {
  resetOrchestratorOperationsForTests()
  rmSync(ROOT, { recursive: true, force: true })
})

// orch.py as the driver is called: `orch.py migrate_chat --marker <path>`. It says it started, is
// still asleep when its daemon exits, then writes the marker and its verdict line.
const STUB_ORCH = `import pathlib, sys, time
marker = pathlib.Path(sys.argv[sys.argv.index("--marker") + 1])
pathlib.Path(str(marker) + ".started").write_text("1")
time.sleep(5)
marker.write_text("moved")
print("moved: example chat", flush=True)
`

test('a move started by a daemon that exits finishes, and the next daemon answers its id with the result', async () => {
  const dir = join(ROOT, 'toolbox')
  const marker = join(ROOT, 'marker')
  await Bun.write(join(dir, 'orch.py'), STUB_ORCH)

  const daemon = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures', 'orchestrator-move-daemon.ts'),
      dir,
      marker,
    ],
    // The preload's scratch state is in process.env, which Bun.spawn does not pass unless told.
    { env: process.env, stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  const exited = await daemon.exited
  const id = (await new Response(daemon.stdout).text()).trim()
  expect(exited, await new Response(daemon.stderr).text()).toBe(0)
  // The daemon is gone and the move is still under way.
  expect(existsSync(`${marker}.started`)).toBe(true)
  expect(existsSync(marker)).toBe(false)

  expect(await adoptOrchestratorRuns()).toBeGreaterThanOrEqual(1)
  expect(getOrchestratorOperation(id)?.status).toBe('running')

  const until = Date.now() + 60_000
  while (getOrchestratorOperation(id)?.status === 'running' && Date.now() < until)
    await Bun.sleep(200)
  const op = getOrchestratorOperation(id)
  expect(op?.status).toBe('done')
  const run = op?.result as OrchestratorRun
  expect(run.exitCode).toBe(0)
  expect(run.script).toBe('migrate_chat')
  expect(run.stdout).toContain('moved: example chat')
  expect(readFileSync(marker, 'utf8')).toBe('moved')
}, 120_000)

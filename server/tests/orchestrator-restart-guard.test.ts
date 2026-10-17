// server/tests/orchestrator-restart-guard.test.ts: a running chat move no longer holds a restart.
//
// WHY (2026-10-08, 2026-10-17): a peer session restarted the daemon 23 minutes into a 9-chat
// migrate_batch; the batch died with the daemon, two chats were left on both accounts and seven were
// never tried. From then on /api/daemon/restart refused while a move ran (moveRestartRefusal). The
// owner, 2026-10-17: each part of AgentHydra restarts on its own without blocking the others. A move
// now runs under a runner and the next daemon takes it on (orchestrator-move-outlives-daemon.test.ts),
// so the restart guard must let a running move through; on origin/main before this, it refused with
// the move's name.
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetOrchestratorOperationsForTests, runOrchestrator } from '../src/orchestrator'
import { restartRefusal } from '../src/restart-refusal'

const ROOT = mkdtempSync(join(tmpdir(), 'orch-restart-root-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const never = () => new Promise<never>(() => {})

// The held run below never settles, so its lock must be handed back here (see orchestrator-stale-lock).
afterEach(() => resetOrchestratorOperationsForTests())

test('a running chat move does not refuse a daemon restart', async () => {
  const dir = mkdtempSync(join(ROOT, 'orch-restart-'))
  writeFileSync(join(dir, 'orch.py'), '# stub\n')
  void runOrchestrator({ script: 'migrate_batch', timeoutMs: 600_000 }, { dir, spawn: never })
  await Bun.sleep(10)

  expect(restartRefusal(false)).toBeNull()
})

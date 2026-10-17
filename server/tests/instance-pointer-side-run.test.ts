// server/tests/instance-pointer-side-run.test.ts — a daemon with a relocated store must not take
// the machine-wide pointer.
//
// The defect this exists for, in full: on 2026-09-12 a session started a daemon from source on port
// 7799 with a scratch database to click through a UI change. It overwrote `~/.agenthydra/
// runtime.json` to name itself and exited without restoring it, and from then on every MCP tool,
// every orchestrator script and every hydralib call on the machine dialled the dead 7799 and
// reported the daemon down — while the real one answered /api/health 200 on 7787 the whole time.
//
// The pointer decision is made at IMPORT time from config.ts's CONFIG_DIR and DATA_DIR, and this
// suite's preload always runs it on the primary branch. So each case boots the REAL instance.ts in
// a child bun with its own AGENTHYDRA_HOME / AGENTHYDRA_DATA_DIR, records a pointer, and reports
// which runtime.json moved. That exercises the shipped rule, not a copy of it.

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOD = JSON.stringify(join(import.meta.dir, '..', 'src', 'instance.ts'))
// A child bun boot of the real module: a few seconds on a loaded PC, so the timeout is explicit.
const SPAWNS_A_CHILD_BUN = 30_000
const SHARED_PORT = 7787
const CHILD_PORT = 7799

/** Boot instance.ts in a child bun with the given state dirs and record one pointer. */
function recordPointerFrom(home: string, config: string, data: string): void {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    AGENTHYDRA_HOME: config,
    AGENTHYDRA_DATA_DIR: data,
    AGENTHYDRA_DB: join(data, 'test.db'),
  }
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { writeInstanceInfo } = await import(${MOD});
       writeInstanceInfo(${CHILD_PORT}, {});`,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  if (!proc.success) throw new Error(`child boot failed: ${proc.stderr.toString()}`)
}

/** A shared pointer as the real daemon left it: a live primary on the usual port. */
function seedSharedPointer(config: string): string {
  mkdirSync(config, { recursive: true })
  const seeded = JSON.stringify({
    port: SHARED_PORT,
    pid: 1,
    url: `http://127.0.0.1:${SHARED_PORT}`,
  })
  writeFileSync(join(config, 'runtime.json'), seeded)
  return seeded
}

test(
  'a side-run writes its pointer beside its own data and leaves the shared pointer alone',
  () => {
    // Contract: a data dir outside the config dir is a side-run. Regression: the 2026-09-12 hijack,
    // when a scratch daemon overwrote the shared runtime.json and every client dialled a dead 7799.
    const home = mkdtempSync(join(tmpdir(), 'agenthydra-side-run-'))
    try {
      const config = join(home, '.agenthydra')
      const scratch = join(home, 'probe-data')
      const seeded = seedSharedPointer(config)

      recordPointerFrom(home, config, scratch)

      expect(readFileSync(join(config, 'runtime.json'), 'utf8')).toBe(seeded)
      const beside = JSON.parse(readFileSync(join(scratch, 'runtime.json'), 'utf8'))
      expect(beside.port).toBe(CHILD_PORT)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'the primary install writes the shared pointer and none inside its data dir',
  () => {
    // Contract: a data dir inside the config dir is the primary install, so the machine-wide pointer
    // is the one that names it. Regression: a rule that always sidecars would leave every client on
    // a stale shared pointer.
    const home = mkdtempSync(join(tmpdir(), 'agenthydra-primary-'))
    try {
      const config = join(home, '.agenthydra')
      const data = join(config, 'data')
      mkdirSync(data, { recursive: true })

      recordPointerFrom(home, config, data)

      const shared = JSON.parse(readFileSync(join(config, 'runtime.json'), 'utf8'))
      expect(shared.port).toBe(CHILD_PORT)
      expect(existsSync(join(data, 'runtime.json'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
  SPAWNS_A_CHILD_BUN,
)

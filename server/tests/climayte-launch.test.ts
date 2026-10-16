// server/tests/climayte-launch.test.ts — a new attempt's launch against the fake CLI: the worker no
// longer carries the last attempt's summary line (Desk 2 showed 'finished (...)' under a running chat).

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteJournal,
  climayteRun,
  climayteSend,
  climayteWait,
  killsLanded,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { setSpendKit, workers } from '../src/climayte-core'
import { harnessKit } from './mocks/climayte-kit'
import { ATTEMPT_MS } from './mocks/climayte-timing'

setSpendKit(harnessKit)

describe('a new attempt does not show the summary line of the one before it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-launch-'))
  const cwd = join(root, 'work')
  const slowDir = join(root, 'acct-slow')
  for (const d of [cwd, slowDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(slowDir, 'fake-slow'), '')
  const stale = 'finished (3 turns; session so far $1.00)'
  let group = ''

  afterAll(async () => {
    if (group) climayteCancel({ group })
    await killsLanded()
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test(
    'a steered attempt starts with no line from the attempt it stopped',
    async () => {
      setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
      setCliMayteAccountsProvider(() => [
        { id: 'slow-1', num: 7, name: 'slow', configDir: slowDir, sessionPct: 0, weekPct: 0 },
      ])
      startCliMayte()
      const run = climayteRun({
        tasks: [
          {
            prompt: 'a slow task',
            cwd,
            title: 'launch activity',
            model: 'sonnet',
            effort: 'medium',
            ownerWords: 'a new attempt starts with no stale summary line',
          },
        ],
      })
      group = run.group
      const id = run.workers[0]?.id as string
      const w = () => workers.get(id)
      const deadline = Date.now() + ATTEMPT_MS
      const started = () => {
        const log = w()?.attempts.at(-1)?.log
        return !!log && existsSync(log) && readFileSync(log, 'utf8').includes('"subtype":"init"')
      }
      while (!started() && Date.now() < deadline) await Bun.sleep(50)

      w()!.lastActivity = stale
      expect(climayteSend(id, 'STEER NOW', { urgent: true })).toMatchObject({
        ok: true,
        urgent: true,
      })
      const next = Date.now() + ATTEMPT_MS
      while ((w()?.attempts.length ?? 0) < 2 && Date.now() < next) await climayteWait({ id }, 50)

      expect(w()?.attempts.length).toBe(2)
      expect(climayteJournal({ id }).some((e) => e.event === 'follow-up-delivered')).toBe(true)
      expect(w()?.lastActivity).not.toBe(stale)
    },
    2 * ATTEMPT_MS + 10_000,
  )
})

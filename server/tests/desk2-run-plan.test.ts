// desk2.ts runPlan starts Desk 2's launcher (start.ps1) without waiting on it. On Windows a detached Bun start gave
// PowerShell a pid and it ran nothing (2026-10-17), so desk2.start() never started Desk 2 and desk2-watch.ts could not
// bring a dead one back. This runs a real PowerShell the same way and waits for what it writes.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPlan } from '../src/desk2'

describe.skipIf(process.platform !== 'win32')('desk2 runPlan on Windows', () => {
  test('a launcher it does not wait on still runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk2-run-plan-'))
    const out = join(dir, 'ran.txt')
    try {
      await runPlan(
        {
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-WindowStyle',
            'Hidden',
            '-Command',
            `Set-Content -LiteralPath '${out}' -Value ok`,
          ],
          cwd: dir,
          env: { ...process.env },
          logPath: null,
          pidFile: null,
        },
        false,
      )
      const until = Date.now() + 20_000
      while (!existsSync(out) && Date.now() < until) await Bun.sleep(100)
      expect(existsSync(out)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

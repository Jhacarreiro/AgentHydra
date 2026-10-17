import { expect, test } from 'bun:test'
import { join } from 'node:path'

// Keep the native process-handle proof in its own bounded process: it must not
// share Win32 FFI or child-exit callbacks with unrelated TCP protocol tests.
for (const kind of ['browser-pool', 'request-coordinator'] as const) {
  test.skipIf(process.platform !== 'win32')(
    `Free ${kind} survives its spawning Bun parent exiting without a visible console`,
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'fixtures/free-service-parent-exit.fixture.ts'),
          kind,
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 100_000 },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Synthetic ${kind} lifetime proof failed (${code}): ${err}`)
      expect(JSON.parse(out.trim())).toEqual({ kind, verified: true })
    },
    110_000,
  )
}

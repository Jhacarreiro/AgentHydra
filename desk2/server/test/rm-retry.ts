// A test's folder remove that really retries. Bun's rmSync ignores maxRetries and retryDelay (Bun 1.4.3 threw EBUSY
// after 0 ms with maxRetries: 10, 2026-10-17), and Windows holds a folder for a moment after the processes in it are
// gone, so the cleanups that passed those options tried once (scripts/checks/rm-retry-option-ignored.mjs at the repo
// root). desk2's suites have their own copy of the root's server/tests/rm-retry.ts, as they have their own preload.
import { rmSync } from 'node:fs'

const HELD = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

/** rmSync(path, { recursive: true, force: true }), tried again every `delayMs` while Windows still holds it. */
export function rmRetry(path: string, tries = 50, delayMs = 100): void {
  for (let i = 1; ; i++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      if (i >= tries || !HELD.has((err as NodeJS.ErrnoException).code ?? '')) throw err
      Bun.sleepSync(delayMs)
    }
  }
}

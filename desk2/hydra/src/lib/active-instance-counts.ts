import type { FreeInstance } from '@desk/shared/free-instances'
import type { CMAccount, CMInstance, CliInstance, CodexInstance, DshInstance } from './api'

type DesktopLogin = Pick<CMInstance, 'loginUuid' | 'appSignedOut'> & {
  account?: Pick<CMAccount, 'status'> | null
}

/** Stored identity is available before lazy account resolution; an explicit sign-out wins over it. */
export function desktopSignedIn(instance: DesktopLogin): boolean {
  return instance.loginUuid != null && !instance.appSignedOut && instance.account?.status !== 'loggedout'
}

/** Header availability only: no provider calls, quota thresholds, search, or changes to the row lists. */
export function activeInstanceCounts(rows: {
  desktop: readonly DesktopLogin[]
  codex: readonly Pick<CodexInstance, 'loggedIn'>[]
  dsh: readonly Pick<DshInstance, 'running'>[]
  cli: readonly Pick<CliInstance, 'loggedIn' | 'movedAway'>[]
  free: readonly (Pick<FreeInstance, 'loggedIn' | 'poolState'> & { movedAway?: unknown })[]
}): Record<'all' | 'desktop' | 'cli' | 'free', number> {
  const desktop = rows.desktop.filter(desktopSignedIn).length +
    rows.codex.filter((i) => i.loggedIn).length +
    // DeepSeek has no account login field; its existing status reports a serving harness.
    rows.dsh.filter((i) => i.running).length
  const cli = rows.cli.filter((i) => i.loggedIn && !i.movedAway).length
  const free = rows.free.filter((i) => i.loggedIn && !i.poolState && !i.movedAway).length
  return { all: desktop + cli + free, desktop, cli, free }
}

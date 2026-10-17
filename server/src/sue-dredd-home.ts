// Where the private sue-dredd checkout lives: SUE_DREDD_HOME first, then the sue-dredd folder beside the AgentHydra
// checkout. One resolver for the Sue/Dredd doors, the price check and the CrAInium people door.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The folders to look in, best first. */
export function sueDreddCandidates(
  env: Record<string, string | undefined>,
  appRoot: string,
): string[] {
  const fromEnv = (env.SUE_DREDD_HOME ?? '').trim()
  const beside = join(resolve(appRoot), '..', 'sue-dredd')
  return fromEnv ? [resolve(fromEnv), beside] : [beside]
}

/** The first checkout folder that holds `entry` (a path inside it), or null. */
export function findSueDredd(
  entry: string,
  env: Record<string, string | undefined>,
  appRoot: string,
): string | null {
  return sueDreddCandidates(env, appRoot).find((home) => existsSync(join(home, entry))) ?? null
}

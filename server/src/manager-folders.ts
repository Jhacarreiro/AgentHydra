// Where a manager's persona content lives: two homes, one manager. The people store's people/manager/<slug>/ (the
// folder CrAInium syncs into) comes first, the legacy managers/<slug>/ second. A file is read from the first home that
// holds it, so a slug in both is one manager and its people copy wins. Runtime state (sessions/, analytics/,
// router.log) stays in the legacy managers folder. managers/router.mjs and hydra-core/catalog/build.mjs carry the same
// two-place rule; keep them in step with this file.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const MANAGER_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/

type Env = Record<string, string | undefined>

export function peopleDir(env: Env = process.env): string {
  return env.AGENTHYDRA_PEOPLE_DIR?.trim() || join(homedir(), '.agenthydra', 'people')
}

export function managersDir(env: Env = process.env): string {
  return env.AGENTHYDRA_MANAGERS_DIR?.trim() || join(homedir(), '.agenthydra', 'managers')
}

/** A manager's folder in each home, people first. */
export function managerHomes(slug: string, env: Env = process.env): string[] {
  return [join(peopleDir(env), 'manager', slug), join(managersDir(env), slug)]
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true
}

/** A manager's file (persona.json, brief.md, playbook/x.md, avatar.png) from the first home that holds it; null when neither does. */
export function managerFile(slug: string, name: string, env: Env = process.env): string | null {
  for (const dir of managerHomes(slug, env)) {
    const file = join(dir, name)
    if (isFile(file)) return file
  }
  return null
}

/** Where a manager's persona content is written: the home that holds its persona.json (people first), else the legacy folder. */
export function managerWriteDir(slug: string, env: Env = process.env): string {
  const [people, legacy] = managerHomes(slug, env)
  return isFile(join(people, 'persona.json')) ? people : legacy
}

/** Every manager once: a folder with a persona.json in either home. */
export function managerSlugs(env: Env = process.env): string[] {
  const slugs = new Set<string>()
  for (const root of [join(peopleDir(env), 'manager'), managersDir(env)]) {
    if (!existsSync(root)) continue
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (
        d.isDirectory() &&
        MANAGER_SLUG.test(d.name) &&
        isFile(join(root, d.name, 'persona.json'))
      )
        slugs.add(d.name)
    }
  }
  return [...slugs].sort()
}

/** The folders a manager's playbook or brief may be read from; a transcript's Read of one of them is that manager's. */
export function managerRoots(env: Env = process.env): string[] {
  return [join(peopleDir(env), 'manager'), managersDir(env)]
}

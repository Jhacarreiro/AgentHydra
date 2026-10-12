// The standing agents' manifests (shared/archaingel.ts says what the contract is). One file per agent in
// <desk home>/archaingel/agents: a manifest that checks out is an agent to look at and tick; one that does not is
// listed as 'broken' with its reason and never run. Nothing here runs a command.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
export const TIMEOUT_MIN = 5
export const TIMEOUT_MAX = 360
export const TIMEOUT_DEFAULT = 120

export interface Manifest {
  id: string
  name: string
  tick: string[]
  status: string[]
  cwd?: string
  timeoutMinutes: number
}

/** One <id>.json in the agents folder: its manifest, or the reason it is broken. */
export type Entry = { id: string; manifest: Manifest; broken: null } | { id: string; manifest: null; broken: string }

const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0)

/** The manifest's body, checked; throws with the reason when it does not hold. */
export function parseManifest(id: string, text: string): Manifest {
  if (!AGENT_ID.test(id)) throw new Error('the file name is the id: 1 to 40 of a-z, 0-9 and -, starting with a letter or digit')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('the file is not JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('the file must hold one JSON object')
  const m = body as Record<string, unknown>
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error('"name" must be a non-empty string')
  if (!isArgv(m.tick)) throw new Error('"tick" must be a command: a list of strings, the program first (run with no shell)')
  if (!isArgv(m.status)) throw new Error('"status" must be a command: a list of strings, the program first (run with no shell)')
  if (m.cwd !== undefined && (typeof m.cwd !== 'string' || !m.cwd)) throw new Error('"cwd" must be a folder path')
  const minutes = m.timeoutMinutes ?? TIMEOUT_DEFAULT
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < TIMEOUT_MIN || minutes > TIMEOUT_MAX)
    throw new Error(`"timeoutMinutes" must be a number from ${TIMEOUT_MIN} to ${TIMEOUT_MAX}`)
  return { id, name: m.name.trim(), tick: m.tick, status: m.status, ...(typeof m.cwd === 'string' ? { cwd: m.cwd } : {}), timeoutMinutes: minutes }
}

/** Every *.json in the agents folder, by file name. A missing folder has no agents. */
export function readEntries(dir: string): Entry[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f): Entry => {
      const id = f.slice(0, -'.json'.length)
      try {
        return { id, manifest: parseManifest(id, readFileSync(join(dir, f), 'utf8')), broken: null }
      } catch (err) {
        return { id, manifest: null, broken: err instanceof Error ? err.message : String(err) }
      }
    })
}

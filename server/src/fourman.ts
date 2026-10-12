// 4MAN, the owner's board of AI work, read through its own engine (tools/4man/4man.mjs in the Connections
// checkout). Read-only: AgentHydra never writes to 4MAN. Absent engine means every answer says available:false.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ENGINE_TIMEOUT_MS = 15_000
export const CACHE_MS = 30_000
export const LIST_CAP = 200
export const BODY_CHARS = 600
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const NOT_INSTALLED = '4MAN is not installed on this PC'
const NOTES_WHY =
  'Notes to-dos are read through the Connections MCP sign-in, which the daemon does not hold yet'

export interface FourmanEngine {
  path: string
  via: 'env' | 'claude-config'
}

export interface FourmanTask {
  id: string
  title: string
  body: string
  project?: string | null
  status?: string
  tier?: string
  quadrant?: string
  type?: string
  size?: string
  impact?: string
  live?: boolean
  risky?: boolean
  needsHuman?: boolean
  claimedBy?: string | null
  createdAt?: string
  updatedAt?: string
  tierWhy?: string
}

export interface FourmanNoteTodo {
  id: string
  title: string
  due?: string
  done: boolean
  labels?: string[]
}

export interface FourmanBoard {
  available: boolean
  why?: string
  project: string | null
  readyCount: number
  ready: FourmanTask[]
  human: FourmanTask[]
  claimed: FourmanTask[]
  pending: FourmanTask[]
  notes: FourmanNoteTodo[]
  fetchedAt: string
}

export interface FourmanStatus {
  available: boolean
  why?: string
  engine?: string
  notes: { available: boolean; why?: string }
}

export type FourmanScope = { folder: string } | { project: string } | { all: true }

/** The engine from AGENTHYDRA_FOURMAN, else from the Connections local MCP's entry in ~/.claude.json, else none. */
export function findEngine(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): FourmanEngine | null {
  const fromEnv = env.AGENTHYDRA_FOURMAN?.trim()
  if (fromEnv) return existsSync(fromEnv) ? { path: fromEnv, via: 'env' } : null
  const fromConfig = engineFromClaudeConfig(join(home, '.claude.json'))
  return fromConfig ? { path: fromConfig, via: 'claude-config' } : null
}

function engineFromClaudeConfig(file: string): string | null {
  let config: unknown
  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers
  if (!servers || typeof servers !== 'object') return null
  for (const entry of Object.values(servers)) {
    const args = (entry as { args?: unknown } | null)?.args
    if (!Array.isArray(args)) continue
    for (const arg of args) {
      if (typeof arg !== 'string') continue
      const p = arg.replace(/\\/g, '/')
      const at = p.toLowerCase().indexOf('/services/studio/local-mcp')
      if (at < 0) continue
      const engine = join(p.slice(0, at), 'tools', '4man', '4man.mjs')
      if (existsSync(engine)) return engine
    }
  }
  return null
}

export function runEngine(
  engine: string,
  args: string[],
  timeoutMs = ENGINE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(
      'node',
      [engine, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout) => {
        if (err) {
          const late = (err as { killed?: boolean }).killed
          reject(
            new Error(late ? `4MAN did not answer within ${timeoutMs / 1000} s` : '4MAN failed'),
          )
          return
        }
        try {
          const parsed = JSON.parse(String(stdout))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resolve(parsed)
          else reject(new Error('4MAN printed no board'))
        } catch {
          reject(new Error('4MAN printed no JSON'))
        }
      },
    )
  })
}

const TASK_KEYS = [
  'id',
  'title',
  'project',
  'status',
  'tier',
  'quadrant',
  'type',
  'size',
  'impact',
  'live',
  'risky',
  'needsHuman',
  'claimedBy',
  'createdAt',
  'updatedAt',
  'tierWhy',
] as const

function trimTask(raw: unknown): FourmanTask {
  const t = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of TASK_KEYS) if (t[k] !== undefined) out[k] = t[k]
  out.body = typeof t.body === 'string' ? t.body.slice(0, BODY_CHARS) : ''
  return out as unknown as FourmanTask
}

function list(v: unknown): FourmanTask[] {
  return Array.isArray(v) ? v.slice(0, LIST_CAP).map(trimTask) : []
}

function shape(raw: Record<string, unknown>): FourmanBoard {
  const ready = list(raw.ready)
  return {
    available: true,
    project: typeof raw.project === 'string' ? raw.project : null,
    readyCount: typeof raw.readyCount === 'number' ? raw.readyCount : ready.length,
    ready,
    human: list(raw.human),
    claimed: list(raw.claimed),
    pending: list(raw.pending),
    notes: [],
    fetchedAt: new Date().toISOString(),
  }
}

export function unavailableBoard(why: string): FourmanBoard {
  return {
    available: false,
    why,
    project: null,
    readyCount: 0,
    ready: [],
    human: [],
    claimed: [],
    pending: [],
    notes: [],
    fetchedAt: new Date().toISOString(),
  }
}

const cache = new Map<string, { at: number; load: Promise<FourmanBoard> }>()

function cachedBoard(key: string, engine: string, args: string[]): Promise<FourmanBoard> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.load
  const load = runEngine(engine, args).then(shape)
  const entry = { at: Date.now(), load }
  cache.set(key, entry)
  load.catch(() => {
    if (cache.get(key) === entry) cache.delete(key)
  })
  return load
}

export async function fourmanBoard(scope: FourmanScope): Promise<FourmanBoard> {
  const engine = findEngine()
  if (!engine) return unavailableBoard(NOT_INSTALLED)
  const args =
    'folder' in scope
      ? ['list', '--folder', scope.folder, '--json']
      : 'project' in scope
        ? ['list', '--project', scope.project, '--json']
        : ['list', '--all', '--json']
  try {
    return await cachedBoard(`${engine.path}\0${args.join('\0')}`, engine.path, args)
  } catch (err) {
    return unavailableBoard(err instanceof Error ? err.message : '4MAN failed')
  }
}

export function fourmanStatus(): FourmanStatus {
  const notes = { available: false, why: NOTES_WHY }
  const engine = findEngine()
  if (!engine) return { available: false, why: NOT_INSTALLED, notes }
  return { available: true, engine: engine.path, notes }
}

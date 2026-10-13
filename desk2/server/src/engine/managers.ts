// The managers Desk shows on a chat: the folder AGENTHYDRA_MANAGERS_DIR (default ~/.agenthydra/managers) holds
// one folder per manager with a persona.json, and sessions/<claude session id>.json names the manager a session is on.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const MANAGER_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/

export function managersDir(): string {
  return process.env.AGENTHYDRA_MANAGERS_DIR?.trim() || join(homedir(), '.agenthydra', 'managers')
}

function readObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function managerName(slug: string): string | null {
  if (!MANAGER_SLUG.test(slug)) return null
  return text(readObject(join(managersDir(), slug, 'persona.json'))?.name)
}

function sessionManager(sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null
  return text(readObject(join(managersDir(), 'sessions', `${sessionId}.json`))?.manager)
}

export function currentManager(
  pin: string | null | undefined,
  sessionId: string | null | undefined,
): { slug: string; name: string } | null {
  const slug = pin || (sessionId ? sessionManager(sessionId) : null)
  if (!slug) return null
  const name = managerName(slug)
  return name ? { slug, name } : null
}

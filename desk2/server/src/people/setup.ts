// "Your people": read and write the people folders (docs/PEOPLE.md) and run the Hydra Core catalog build.
// The highest authority is the creator family (tier owner by default); managers are the manager family. The legacy
// ~/.agenthydra/managers folders count as managers already set up.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PERSON_SLUG, slugOf, type PeopleSaveRequest, type PeopleSaveResponse, type PeopleState, type PersonDraft } from '@shared/people'
import { managersDir } from '../engine/managers'
import { writeFlushed } from '../write-flushed'
import { STARTERS } from './starters'

const BUILDER = resolve(import.meta.dir, '../../../../hydra-core/catalog/build.mjs')
const MAX_TEXT = 8000

export const peopleDir = (): string => join(homedir(), '.agenthydra', 'people')

function folders(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'persona.json')))
  } catch {
    return []
  }
}

function nameOf(dir: string, slug: string): string {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, slug, 'persona.json'), 'utf8'))
    const n = v && typeof v === 'object' ? (v as { name?: unknown }).name : null
    return typeof n === 'string' && n.trim() ? n.trim() : slug
  } catch {
    return slug
  }
}

export function peopleState(): PeopleState {
  const dir = peopleDir()
  const authorities = folders(join(dir, 'creator'))
  const own = folders(join(dir, 'manager')).map((s) => nameOf(join(dir, 'manager'), s))
  const legacy = folders(managersDir()).map((s) => nameOf(managersDir(), s))
  const managers = [...new Set([...own, ...legacy])]
  return {
    empty: authorities.length === 0 && managers.length === 0,
    folder: dir,
    authority: authorities.length ? nameOf(join(dir, 'creator'), authorities[0]) : null,
    managers,
    starters: STARTERS.map((s) => ({ ...s })),
  }
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '')

function writePerson(family: 'creator' | 'manager', slug: string, p: PersonDraft): string {
  const dir = join(peopleDir(), family, slug)
  mkdirSync(dir, { recursive: true })
  const persona: Record<string, unknown> = { name: p.name, oneLiner: clean(p.oneLiner, 160) || (family === 'creator' ? 'Whose rulings win.' : p.name) }
  if (clean(p.title, 80)) persona.title = clean(p.title, 80)
  if (family === 'creator') persona.tier = 'owner'
  writeFlushed(join(dir, 'persona.json'), `${JSON.stringify(persona, null, 2)}\n`)
  writeFlushed(join(dir, 'brief.md'), `${p.brief.trim()}\n`)
  return dir
}

/** Runs the repo's catalog builder so Hydra Core sees the people at once. Never throws. */
export async function buildCatalog(): Promise<{ ok: boolean; message: string }> {
  try {
    const proc = Bun.spawn([process.execPath, BUILDER], { stdout: 'pipe', stderr: 'pipe', env: process.env })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const last = (code === 0 ? out : err || out).trim().split('\n').filter(Boolean).pop() ?? ''
    return code === 0 ? { ok: true, message: last || 'Catalog built.' } : { ok: false, message: last || `The catalog build exited ${code}.` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export class BadPeople extends Error {}

export async function savePeople(req: PeopleSaveRequest, build = buildCatalog): Promise<PeopleSaveResponse> {
  const managers = Array.isArray(req?.managers) ? req.managers : []
  if (managers.length > 30) throw new BadPeople('That is more managers than the setup writes at once.')
  const written: string[] = []
  const a = req?.authority
  if (a) {
    const name = clean(a.name, 80)
    if (!name) throw new BadPeople('The highest authority needs a name.')
    const slug = slugOf(name)
    if (!PERSON_SLUG.test(slug)) throw new BadPeople('Use letters or numbers in the name.')
    written.push(writePerson('creator', slug, { name, brief: clean(a.brief, MAX_TEXT) || `${name}'s rulings win.`, oneLiner: clean(a.oneLiner, 160) }))
  }
  for (const m of managers) {
    const name = clean(m.name, 80)
    if (!name) throw new BadPeople('Every manager needs a name.')
    const slug = clean(m.slug, 61) || slugOf(name)
    if (!PERSON_SLUG.test(slug)) throw new BadPeople(`"${name}" is not a usable folder name.`)
    written.push(writePerson('manager', slug, { name, title: clean(m.title, 80), oneLiner: clean(m.oneLiner, 160), brief: clean(m.brief, MAX_TEXT) || `${name} is a manager.` }))
  }
  const catalog = written.length ? await build() : { ok: true, message: 'Nothing to write.' }
  return { written, catalog, state: peopleState() }
}

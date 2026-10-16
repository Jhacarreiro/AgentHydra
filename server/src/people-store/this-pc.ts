// "This PC": the docs/PEOPLE.md folders, ~/.agenthydra/people/<family>/<slug>/{persona.json, brief.md, learnings.json,
// playbook/<name>.md, avatar.jpg|png|webp}.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  FAMILIES,
  type Learning,
  type PeopleHome,
  type PersonFile,
  type PersonRecord,
  type PersonSummary,
  parseId,
  personId,
  summaryOf,
} from './types'

export const agentHydraDir = (home = homedir()): string => join(home, '.agenthydra')

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    // floor-ok: a missing or half-written file is a person we skip, never a crash
    return null
  }
}

const PLAYBOOK = /^[a-z0-9][a-z0-9._-]{0,80}\.md$/
const AVATARS = ['avatar.jpg', 'avatar.png', 'avatar.webp']
const AVATAR_MAX = 512 * 1024

/** The playbook and avatar files of a person folder, with the newest mtime among them. */
function readFiles(d: string): { files: PersonFile[]; newest: number } {
  const files: PersonFile[] = []
  let newest = 0
  try {
    for (const n of readdirSync(join(d, 'playbook')).sort()) {
      if (!PLAYBOOK.test(n)) continue
      const f = join(d, 'playbook', n)
      files.push({ path: `playbook/${n}`, text: readFileSync(f, 'utf8') })
      newest = Math.max(newest, mtimeMs(f))
    }
  } catch {
    // floor-ok: a person with no playbook folder
  }
  for (const n of AVATARS) {
    const f = join(d, n)
    try {
      if (statSync(f).size > AVATAR_MAX) continue
      files.push({ path: n, base64: readFileSync(f).toString('base64') })
      newest = Math.max(newest, mtimeMs(f))
    } catch {
      // floor-ok: a person with no avatar of this kind
    }
  }
  return { files, newest }
}

const mtimeMs = (file: string): number => {
  try {
    return statSync(file).mtimeMs
  } catch {
    // floor-ok: a file the person does not have
    return 0
  }
}

export function createThisPcHome(opts: { home?: string } = {}): PeopleHome {
  const root = join(agentHydraDir(opts.home), 'people')
  const dir = (family: string, slug: string) => join(root, family, slug)

  function read(family: string, slug: string): PersonRecord | null {
    const d = dir(family, slug)
    const persona = readJson<Record<string, unknown>>(join(d, 'persona.json'))
    if (!persona || typeof persona !== 'object') return null
    const briefName =
      typeof persona.brief === 'string' && persona.brief ? persona.brief : 'brief.md'
    const briefFile = join(d, briefName)
    let brief: string | null = null
    try {
      brief = readFileSync(briefFile, 'utf8')
    } catch {
      // floor-ok: a person with no brief
    }
    const learnings = readJson<Learning[]>(join(d, 'learnings.json'))
    const extra = readFiles(d)
    const newest = Math.max(
      extra.newest,
      mtimeMs(join(d, 'persona.json')),
      mtimeMs(briefFile),
      mtimeMs(join(d, 'learnings.json')),
    )
    return {
      id: personId(family, slug),
      family: family as PersonRecord['family'],
      slug,
      persona,
      brief,
      learnings: Array.isArray(learnings) ? learnings : [],
      updatedAt: new Date(newest).toISOString(),
      ...(extra.files.length ? { files: extra.files } : {}),
    }
  }

  return {
    kind: 'pc',
    async list(): Promise<PersonSummary[]> {
      const out: PersonSummary[] = []
      for (const family of FAMILIES) {
        let slugs: string[] = []
        try {
          slugs = readdirSync(join(root, family))
        } catch {
          // floor-ok: a family folder that does not exist yet
        }
        for (const slug of slugs) {
          if (!parseId(personId(family, slug))) continue
          const r = read(family, slug)
          if (r) out.push(summaryOf(r))
        }
      }
      return out.sort((a, b) => a.id.localeCompare(b.id))
    },
    async get(id) {
      const p = parseId(id)
      return p ? read(p.family, p.slug) : null
    },
    async put(record) {
      const p = parseId(record.id)
      if (!p) throw new Error(`not a person id: ${record.id}`)
      const d = dir(p.family, p.slug)
      mkdirSync(d, { recursive: true })
      const persona = join(d, 'persona.json')
      writeFileSync(persona, `${JSON.stringify(record.persona, null, 2)}\n`)
      const briefName =
        typeof record.persona.brief === 'string' && record.persona.brief
          ? record.persona.brief
          : 'brief.md'
      const briefFile = join(d, briefName)
      if (record.brief !== null) writeFileSync(briefFile, record.brief)
      const learnings = join(d, 'learnings.json')
      if (record.learnings.length || existsSync(learnings))
        writeFileSync(learnings, `${JSON.stringify(record.learnings, null, 2)}\n`)
      // Only the known playbook and avatar paths are written; a file the record lacks is never removed.
      const extras: string[] = []
      for (const f of record.files ?? []) {
        const isPlaybook = /^playbook\/[^/]+$/.test(f.path) && PLAYBOOK.test(f.path.slice(9))
        if (!isPlaybook && !AVATARS.includes(f.path)) continue
        const target = join(d, ...f.path.split('/'))
        if (isPlaybook) {
          if (typeof f.text !== 'string') continue
          mkdirSync(join(d, 'playbook'), { recursive: true })
          writeFileSync(target, f.text)
        } else {
          if (typeof f.base64 !== 'string') continue
          const bytes = Buffer.from(f.base64, 'base64')
          if (bytes.length > AVATAR_MAX) continue
          writeFileSync(target, bytes)
        }
        extras.push(target)
      }
      // The record's own time becomes the files' time, so a pulled copy equals its source.
      const t = new Date(record.updatedAt)
      if (!Number.isNaN(t.getTime())) {
        for (const f of [persona, briefFile, learnings, ...extras])
          if (existsSync(f)) utimesSync(f, t, t)
      }
    },
    async delete(id) {
      const p = parseId(id)
      if (!p) return
      rmSync(dir(p.family, p.slug), { recursive: true, force: true })
    },
  }
}

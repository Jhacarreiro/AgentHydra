import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUILDER = join(import.meta.dir, '..', '..', 'hydra-core', 'catalog', 'build.mjs')

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'catalog-build-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const run = (...args: string[]) =>
  spawnSync('node', [BUILDER, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENTHYDRA_CORE_DIR: '' },
    encoding: 'utf8',
  })

const put = (rel: string, body: unknown) => {
  const file = join(home, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
}

const catalogFile = (name: string) => join(home, '.agenthydra/core/catalog', name)

test('an empty home builds a valid empty catalog with no home path in the output', () => {
  const built = run()
  expect(built.status).toBe(0)
  expect(built.stderr).toBe('')
  const checked = run('--check')
  expect(checked.status).toBe(0)
  expect(checked.stdout).toContain('CHECK OK')
  const out = built.stdout + checked.stdout
  expect(out).not.toContain(home.split('\\').join('/'))
})

test('the builder lists no person: people folders, owner sources and skill experts are the add-on', () => {
  put('.agenthydra/people/manager/ada/persona.json', { name: 'Ada', oneLiner: 'Plans releases' })
  put('.agenthydra/managers/lin/persona.json', { name: 'Lin', oneLiner: 'Keeps the books' })
  put(
    '.claude/skills/grace/SKILL.md',
    '---\nname: grace\ndescription: Grace on compilers. What would Grace say?\n---\n',
  )
  put('.claude/skills/plain/SKILL.md', '---\nname: plain\ndescription: A plain skill.\n---\n')
  put('.agenthydra/core/catalog/sources.json', {
    ownerName: 'Example Owner',
    seats: [{ slug: 'owner-seat', name: 'Example Owner', personaId: 'p1' }],
    companyId: 'c1',
  })
  expect(run().status).toBe(0)
  for (const name of ['managers', 'people', 'boardroom', 'owners'])
    expect(existsSync(catalogFile(`generated-${name}.json`))).toBe(false)
  const skills = JSON.parse(readFileSync(catalogFile('generated-skills.json'), 'utf8')) as {
    id: string
  }[]
  expect(skills.map((e) => e.id)).toEqual(['skill:plain'])
})

test('a rebuild removes the files of the sources that moved out and leaves the add-on file', () => {
  for (const name of ['managers', 'boardroom', 'owners'])
    put(`.agenthydra/core/catalog/generated-${name}.json`, '[]')
  put('.agenthydra/core/catalog/generated-people.json', '[]')
  expect(run().status).toBe(0)
  for (const name of ['managers', 'boardroom', 'owners'])
    expect(existsSync(catalogFile(`generated-${name}.json`))).toBe(false)
  expect(existsSync(catalogFile('generated-people.json'))).toBe(true)
})

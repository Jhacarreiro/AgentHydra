// server/src/people/setup.ts: the setup writes the docs/PEOPLE.md format under an empty home and the catalog build
// sees it. The build runs for real against the repo's hydra-core/catalog/build.mjs with HOME pointed at a temp folder.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presentAddon } from './people-addon-fixture'

// Every key goes back after the file: the folder is removed, and a later file's headless Chrome started under a
// USERPROFILE that no longer exists never opens its debugging port (38 tests, 2026-10-15).
const KEYS = ['HOME', 'USERPROFILE', 'AGENTHYDRA_MANAGERS_DIR', 'AGENTHYDRA_CORE_DIR'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const home = mkdtempSync(join(tmpdir(), 'people-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.AGENTHYDRA_MANAGERS_DIR = join(home, 'legacy-managers')
process.env.AGENTHYDRA_CORE_DIR = join(home, 'core')
const addon = presentAddon(home)
const { peopleState, savePeople } = await import('../src/people/setup')
afterAll(() => {
  for (const k of KEYS)
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  rmSync(home, { recursive: true, force: true })
})

describe('people setup', () => {
  test('a fresh home is empty and offers five invented starters', () => {
    const s = peopleState(addon)
    expect(s.empty).toBe(true)
    expect(s.starters.map((x) => x.slug)).toEqual(['project-coordinator', 'floor-manager', 'backend-engineer', 'ui-designer', 'advertising-lead'])
    expect(JSON.stringify(s.starters)).not.toMatch(/\b(he|she|his|her)\b/i)
  })
  test('saving writes the people format and the build lists them', async () => {
    const res = await savePeople({
      authority: { name: 'Example Owner', brief: 'Decides fast.' },
      managers: [{ slug: 'floor-manager', name: 'Sam Ortega', title: 'Floor manager', oneLiner: 'Runs day-to-day work.', brief: 'Sam runs the floor.' }],
    }, undefined, addon)
    expect(res.catalog.ok).toBe(true)
    const persona = JSON.parse(readFileSync(join(home, '.agenthydra', 'people', 'manager', 'floor-manager', 'persona.json'), 'utf8'))
    expect(persona.name).toBe('Sam Ortega')
    expect(JSON.parse(readFileSync(join(home, '.agenthydra', 'people', 'creator', 'example-owner', 'persona.json'), 'utf8')).tier).toBe('owner')
    expect(readFileSync(join(home, '.agenthydra', 'people', 'creator', 'example-owner', 'brief.md'), 'utf8')).toBe('Decides fast.\n')
    expect(res.state.empty).toBe(false)
    expect(existsSync(join(home, 'core', 'catalog'))).toBe(true)
  })
  test('refuses a manager with no name', async () => {
    await expect(savePeople({ managers: [{ name: ' ', brief: '' }] }, undefined, addon)).rejects.toThrow('name')
  })
})

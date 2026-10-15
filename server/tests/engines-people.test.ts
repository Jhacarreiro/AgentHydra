// A Sue and a Dredd run with an invented person in a temp people home: the engines read their people through the
// people store's folders (docs/PEOPLE.md), so the same install works for a stranger and for the owner. No network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_ROOT } from '../src/config'
import { launchEngine, sueDreddTools } from '../src/mcp-sue-dredd'
import { createThisPcHome } from '../src/people-store'

let base: string
let peopleHome: string
const ENGINES = join(APP_ROOT, 'engines')

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'engines-people-'))
  peopleHome = join(base, '.agenthydra', 'people')
  const store = createThisPcHome({ home: base })
  const at = new Date().toISOString()
  await store.put({
    id: 'expert/sue-fixture-fay',
    family: 'expert',
    slug: 'sue-fixture-fay',
    persona: {
      name: 'Fixture Fay',
      oneLiner: 'An invented visitor for tests.',
      sue: { id: 'fixture-fay', displayName: 'Fixture Fay' },
    },
    brief: null,
    learnings: [],
    updatedAt: at,
  })
  await store.put({
    id: 'dredd-seat/fixture-seat',
    family: 'dredd-seat',
    slug: 'fixture-seat',
    persona: {
      id: 'fixture-seat',
      name: 'Fixture Seat',
      oneLiner: 'An invented seat for tests.',
      rooms: ['product'],
      keywords: ['pricing'],
      jev: 'Is the page about pricing?',
    },
    brief: 'Say what is wrong, plainly.',
    learnings: [],
    updatedAt: at,
  })
  mkdirSync(join(base, 'project'))
  writeFileSync(join(base, 'project', 'README.md'), '# Example project\n')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const engineEnv = () => ({ ...process.env, AGENTHYDRA_PEOPLE_HOME: peopleHome, SUE_BRAIN: '' })

const runNode = async (args: string[], env: Record<string, string | undefined>) => {
  const proc = Bun.spawn(['node', ...args], { cwd: ENGINES, env, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

describe('engines read the people store', () => {
  test('a Sue run lists the fixture person through the sue tool', async () => {
    const tools = sueDreddTools({
      env: { AGENTHYDRA_PEOPLE_HOME: peopleHome, SUE_BRAIN: '' },
      appRoot: APP_ROOT,
      folder: async () => ({ cwd: join(base, 'project'), chatId: null }),
      tmp: () => mkdtempSync(join(base, 'call-')),
      launch: (cmd, args, o) =>
        launchEngine(cmd, args, { ...o, env: { ...o.env, ...engineEnv() } }),
    })
    const out = (await tools
      .find((t) => t.name === 'sue')
      ?.run({ action: 'personas', params: {} })) as Record<string, any>
    expect(out.ok).toBe(true)
    const json = out.json ?? out
    const ids = (json.workspacePersonas ?? []).map((p: { id: string }) => p.id)
    expect(ids).toContain('fixture-fay')
  }, 60_000)

  test('a Dredd run seats the fixture person from the store', async () => {
    const text = await runNode(
      ['dredd/dredd.mjs', '--doctor', '--json', '--root', join(base, 'project')],
      engineEnv(),
    )
    const rows = JSON.parse(text) as { name: string; ok: boolean }[]
    expect(rows.find((r) => r.name === 'seats')?.ok).toBe(true)
    const seated = await runNode(
      [
        '-e',
        "import('./dredd/lib/seats.mjs').then(m=>console.log(JSON.stringify(m.loadSeats(['fixture-seat']).map(s=>s.personaId))))",
      ],
      engineEnv(),
    )
    expect(JSON.parse(seated)).toEqual(['fixture-seat'])
  }, 60_000)

  test('without a people home a stranger gets an empty roster, not an error', async () => {
    const empty = mkdtempSync(join(base, 'empty-'))
    const out = await runNode(
      [
        '-e',
        "import('./dredd/lib/seats.mjs').then(m=>console.log(JSON.stringify(m.loadSeats([]))))",
      ],
      { ...process.env, AGENTHYDRA_PEOPLE_HOME: empty },
    )
    expect(out).toBe('[]')
  }, 30_000)
})

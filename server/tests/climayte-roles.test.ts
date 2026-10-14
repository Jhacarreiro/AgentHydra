// server/tests/climayte-roles.test.ts — every CliMayte worker is a prime, a seat or a drone, and a
// drone never dispatches. The refusal runs in the daemon (climayteRun, climayteWaveStart) from the
// caller the route resolved, so a drone cannot skip it by how it calls. Fixtures are invented.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteRun,
  climayteWaveStart,
  killsLanded,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { JOURNAL_PATH, workers } from '../src/climayte-core'
import { readJournal } from '../src/climayte-journal'
import {
  type CliMayteWorker,
  DRONE_BRIEF,
  DRONE_REFUSAL,
  roleOf,
  toReport,
  toView,
  WORKER_BRIEF,
} from '../src/climayte-lib'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-roles-'))
const CWD = join(scratch, 'repo')
const CORE = join(scratch, 'core')
const PERSONA = 'person:iris-design'
const GROUP = 'roles-test'
const prevCore = process.env.AGENTHYDRA_CORE_DIR

beforeAll(() => {
  mkdirSync(CWD, { recursive: true })
  mkdirSync(join(CORE, 'catalog'), { recursive: true })
  writeFileSync(
    join(CORE, 'catalog', 'hand-test.json'),
    JSON.stringify([
      {
        id: PERSONA,
        kind: 'person',
        name: 'Iris',
        title: 'UI designer',
        tier: 'employee',
        family: 'expert',
        modes: ['consult'],
        when: 'Reviews interface layouts for the example app.',
        tags: ['design'],
        cost: 'low',
        how: 'Looks at the screen and reports what is off.',
        load: { type: 'none' },
      },
    ]),
  )
  process.env.AGENTHYDRA_CORE_DIR = CORE
  setCliMayteAccountsProvider(() => [])
})

afterAll(async () => {
  for (const w of workers.values()) if (w.group === GROUP) climayteCancel({ group: GROUP })
  await killsLanded()
  setCliMayteAccountsProvider(null)
  if (prevCore === undefined) delete process.env.AGENTHYDRA_CORE_DIR
  else process.env.AGENTHYDRA_CORE_DIR = prevCore
  rmSync(scratch, { recursive: true, force: true })
})

/** A worker started with no origin, so its role comes only from its own task fields. */
function start(task: Record<string, unknown>): CliMayteWorker {
  const r = climayteRun({
    tasks: [{ prompt: 'Summarise the example notes.', cwd: CWD, title: 'Roles fixture', ...task }],
    group: GROUP,
  })
  const w = workers.get(r.workers[0].id)
  if (!w) throw new Error('fixture worker missing')
  return w
}

const originOf = (w: CliMayteWorker) => ({ kind: 'worker' as const, workerId: w.id })

describe('roleOf', () => {
  test('a worker without a role is a drone unless it is a chat', () => {
    expect(roleOf({})).toBe('drone')
    expect(roleOf({ chat: false })).toBe('drone')
    expect(roleOf({ chat: true })).toBe('prime')
    expect(roleOf({ chat: true, desk: { manager: 'mgr' } })).toBe('seat')
  })

  test('a stored role wins over the derivation', () => {
    expect(roleOf({ role: 'seat', chat: false })).toBe('seat')
    expect(roleOf({ role: 'drone', chat: true })).toBe('drone')
  })
})

describe('the refusal text and the briefs', () => {
  test('DRONE_REFUSAL is the exact sentence', () => {
    expect(DRONE_REFUSAL).toBe(
      'A drone never starts workers. If this job is too big for one session, stop and end your report with a line starting TOO BIG: and a suggested split; whoever started you splits it.',
    )
  })

  test('the worker brief drops the identity line', () => {
    expect(WORKER_BRIEF).not.toContain('You are a CliMayte worker')
  })

  test('the drone brief carries the TOO BIG protocol', () => {
    expect(DRONE_BRIEF).toContain('TOO BIG:')
  })
})

describe('dispatch by role', () => {
  test('a drone caller is refused and the refusal is journaled', () => {
    const drone = start({ title: 'Drone fixture' })
    expect(roleOf(drone)).toBe('drone')
    expect(() =>
      climayteRun({
        tasks: [{ prompt: 'Start a sub-job.', cwd: CWD, title: 'Sub-job' }],
        group: GROUP,
        origin: originOf(drone),
      }),
    ).toThrow(DRONE_REFUSAL)
    const refused = readJournal(JOURNAL_PATH, { id: drone.id }).filter((e) => e.event === 'refused')
    expect(refused.length).toBeGreaterThan(0)
  })

  test('a drone caller is refused by climayte_manage', async () => {
    const drone = start({ title: 'Drone manage fixture' })
    await expect(
      climayteWaveStart({
        plan: 'Split the notes.',
        cwd: CWD,
        tasks: [],
        origin: originOf(drone),
      }),
    ).rejects.toThrow(DRONE_REFUSAL)
  })

  test('a prime caller may dispatch', () => {
    const prime = start({ title: 'Prime fixture', chat: true })
    expect(roleOf(prime)).toBe('prime')
    const r = climayteRun({
      tasks: [{ prompt: 'Summarise the example notes.', cwd: CWD, title: 'From prime' }],
      group: GROUP,
      origin: originOf(prime),
    })
    expect(r.workers.length).toBe(1)
  })

  test('a seat task needs the role and a catalog persona', () => {
    const prime = start({ title: 'Prime for seat fixture', chat: true })
    const origin = originOf(prime)
    expect(() =>
      climayteRun({
        tasks: [{ prompt: 'Review it.', cwd: CWD, title: 'Seat', role: 'seat' }],
        group: GROUP,
        origin,
      }),
    ).toThrow('a seat needs a persona')
    expect(() =>
      climayteRun({
        tasks: [
          { prompt: 'Review it.', cwd: CWD, title: 'Seat', role: 'seat', persona: 'person:nobody' },
        ],
        group: GROUP,
        origin,
      }),
    ).toThrow('is not in the catalog')
    expect(() =>
      climayteRun({
        tasks: [{ prompt: 'Review it.', cwd: CWD, title: 'Seat', persona: PERSONA }],
        group: GROUP,
        origin,
      }),
    ).toThrow('a task names only the role "seat"')
  })

  test('a seat task with a catalog persona is dispatched with its role', () => {
    const prime = start({ title: 'Prime for valid seat', chat: true })
    const r = climayteRun({
      tasks: [{ prompt: 'Review it.', cwd: CWD, title: 'Seat ok', role: 'seat', persona: PERSONA }],
      group: GROUP,
      origin: originOf(prime),
    })
    const w = workers.get(r.workers[0].id)
    expect(w?.role).toBe('seat')
    expect(w?.persona).toBe(PERSONA)
  })
})

describe('the views carry the role', () => {
  test('toView and toReport return the role and persona', () => {
    const seat = start({ title: 'View fixture', role: 'seat', persona: PERSONA, chat: true })
    const view = toView(seat, Date.now())
    expect(view.role).toBe('seat')
    const report = toReport(view)
    expect(report.role).toBe('seat')
    expect(report.persona).toBe(PERSONA)
  })
})

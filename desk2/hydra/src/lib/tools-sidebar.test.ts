import { describe, expect, it } from 'bun:test'
import type { SidebarRow } from '@desk/shared/hydra-embed'
import type { BabysitterStatus } from '@desk/shared/babysitter'
import type { InstanceManagerStatus } from '@desk/shared/instance-manager'
import type { OrchestratorPlan } from '@desk/shared/orchestrator'
import type { RoutinesStatus } from '@desk/shared/routines'
import { type ToolsSidebarArgs, type ToolsSidebarLabels, toolsSections } from './tools-sidebar'

const labels: ToolsSidebarLabels = {
  overview: 'Overview',
  managers: 'Managers',
  routines: 'Routines',
  babysitter: 'Babysitter',
  orchestrator: 'Orchestrator',
  instanceManager: 'Instance manager',
  routineManager: 'Routine manager',
  on: 'On',
  off: 'Off',
  armed: 'Armed',
  shadow: 'Shadow',
  stopped: (n) => `${n} stopped`,
  waiting: (n) => `${n} waiting`,
}

const idle: ToolsSidebarArgs = {
  babysitter: { enabled: true, stopped: [], accounts: [], acts: [], checkedAt: 1, nextCheckAt: null, error: null } as unknown as BabysitterStatus,
  orchestrator: { mode: 'armed', at: 1, days: 3, rows: [], counts: {}, acts: [] } as unknown as OrchestratorPlan,
  instanceManager: { enabled: true, instances: [], recoveries: [], error: null } as unknown as InstanceManagerStatus,
  routines: { enabled: true, routines: [{ id: 'example-a' }], proposals: [], error: null, store: null } as unknown as RoutinesStatus,
  routineRows: [{ key: 'f:Example', label: 'Example', depth: 0, branch: 'open', count: 1 }],
  query: '',
  labels,
}

const rowsOf = (sections: ReturnType<typeof toolsSections>, key: string): SidebarRow[] =>
  sections.find((s) => s.key === key)?.rows ?? []

describe('the Tools sidebar, with no search', () => {
  it('draws an Overview row, then a Managers group and a Routines group, each labelled and counted', () => {
    const sections = toolsSections(idle)
    expect(sections.map((s) => [s.key, s.label, s.count])).toEqual([
      ['overview', undefined, undefined],
      ['managers', 'Managers', 4],
      ['routines', 'Routines', 1],
    ])
    expect(rowsOf(sections, 'overview').map((r) => r.key)).toEqual(['overview'])
    expect(rowsOf(sections, 'managers').map((r) => r.key)).toEqual(['m:babysitter', 'm:orchestrator', 'm:instances', 'm:routines'])
    expect(rowsOf(sections, 'routines').map((r) => r.key)).toEqual(['f:Example'])
  })

  it('marks the Babysitter row danger when a stopped chat needs a person', () => {
    const stopped = { ...idle, babysitter: { ...idle.babysitter!, stopped: [{ id: 'chat-1', state: 'gave-up' }] } as unknown as BabysitterStatus }
    const row = rowsOf(toolsSections(stopped), 'managers').find((r) => r.key === 'm:babysitter')
    expect(row?.status?.tone).toBe('danger')
    expect(row?.meta).toBe('1 stopped')
  })

  it('marks the Instance manager row warning while a recovery is moving', () => {
    const moving = { ...idle, instanceManager: { ...idle.instanceManager!, recoveries: [{ state: 'moving', chats: [] }] } as unknown as InstanceManagerStatus }
    const row = rowsOf(toolsSections(moving), 'managers').find((r) => r.key === 'm:instances')
    expect(row?.status?.tone).toBe('warning')
  })
})

describe('the Tools sidebar, with a search', () => {
  it('leaves only the matching manager, with its hit range, and no Overview row', () => {
    const sections = toolsSections({ ...idle, query: 'orch', routineRows: [] })
    expect(sections.map((s) => s.key)).toEqual(['managers'])
    expect(rowsOf(sections, 'managers').map((r) => [r.key, r.hit])).toEqual([['m:orchestrator', [0, 4]]])
  })

  it('drops the Managers group when the query matches only a routine', () => {
    const routineOnly: ToolsSidebarArgs = { ...idle, query: 'example', routineRows: [{ key: 'r:example-a', label: 'Example', depth: 1 }] }
    const sections = toolsSections(routineOnly)
    expect(sections.map((s) => s.key)).toEqual(['routines'])
    expect(sections[0]?.count).toBe(1)
  })
})

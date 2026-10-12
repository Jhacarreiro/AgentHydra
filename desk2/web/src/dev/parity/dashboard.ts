import type { Dashboard, DashboardWidget } from '@shared/dashboards'
import { PARITY_NOW } from './clock'
import { CWD } from './fixtures'

const at = (minutesAgo: number) => new Date(PARITY_NOW - minutesAgo * 60_000).toISOString()

const WIDGETS: DashboardWidget[] = [
  { id: 'open-issues', kind: 'stat', title: 'Open issues', value: 14, delta: '+3', tone: 'warn', caption: 'since Monday', updatedAt: at(4), updatedBy: 'Ada' },
  { id: 'nightly', kind: 'stat', title: 'Nightly build', value: 'Passing', tone: 'good', caption: '2 of 2 suites green', updatedAt: at(190), updatedBy: 'Grace' },
  { id: 'milestone', kind: 'progress', title: 'Release 2.4', current: 18, max: 24, unit: 'tasks', tone: 'good', caption: 'Due Friday', updatedAt: at(40), updatedBy: 'Ada' },
  {
    id: 'todo',
    kind: 'list',
    title: 'This week',
    items: [
      { text: 'Write the migration notes', detail: 'docs/migration.md', href: 'C:/Users/me/Desktop/Project/atlas/docs/migration.md', done: true },
      { text: 'Review the import PR', href: 'https://example.test/pulls/42', tone: 'warn' },
      { text: 'Retire the legacy export', tone: 'bad' }
    ],
    updatedAt: at(12),
    updatedBy: 'Grace'
  },
  {
    id: 'velocity',
    kind: 'chart',
    title: 'Tasks closed per day',
    series: [
      { label: 'This week', points: [3, 5, 4, 7, 6, 9, 8] },
      { label: 'Last week', points: [2, 4, 3, 5, 5, 6, 7] }
    ],
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    updatedAt: at(60),
    updatedBy: 'Ada'
  },
  {
    id: 'notes',
    kind: 'note',
    title: 'Notes',
    text: 'The **import** path is stable. Next: move the *retry* loop out of `sync.ts`.\n\n- Keep the old export until 2.5\n- Ask Ren about the quota',
    updatedAt: at(300),
    updatedBy: 'Grace'
  }
]

export const dashboardFixture = (): Dashboard => ({
  workspace: CWD,
  name: 'Atlas',
  widgets: WIDGETS,
  updatedAt: at(4)
})

export const emptyDashboardFixture = (): Dashboard => ({
  workspace: CWD,
  name: 'Atlas',
  widgets: [],
  updatedAt: null
})

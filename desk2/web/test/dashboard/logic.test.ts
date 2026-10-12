import { describe, expect, it } from 'bun:test'
import type { DashboardSummary } from '@shared/dashboards'
import {
  cardSpan,
  chartGeometry,
  chartRange,
  findDashboard,
  gridColumns,
  isWebLink,
  progressPercent,
  removeBody,
  timeAgo,
  widgetSize,
  workspaceKey
} from '../../src/components/dashboard/logic'

const NOW = Date.parse('2026-10-11T12:00:00Z')

describe('workspaceKey and findDashboard', () => {
  it('matches a folder across slashes, a trailing slash and a Windows drive letter case', () => {
    const list: DashboardSummary[] = [
      { workspace: 'C:/Users/me/Projects/atlas/', name: 'Atlas', widgets: 3, updatedAt: null }
    ]
    expect(findDashboard(list, 'c:\\Users\\me\\Projects\\atlas')?.name).toBe('Atlas')
    expect(findDashboard(list, 'C:/Users/me/Projects/other')).toBeUndefined()
  })

  it('keeps a POSIX path case-sensitive', () => {
    expect(workspaceKey('/home/Ada/Atlas')).toBe('/home/Ada/Atlas')
    expect(workspaceKey('/home/ada/atlas/')).toBe('/home/ada/atlas')
  })

  it('finds nothing before the first list has loaded', () => {
    expect(findDashboard(null, 'C:/x')).toBeUndefined()
  })
})

describe('widgetSize and the grid', () => {
  it('defaults stat and progress to small, the rest to wide', () => {
    expect(widgetSize({ kind: 'stat' })).toBe('small')
    expect(widgetSize({ kind: 'progress' })).toBe('small')
    expect(widgetSize({ kind: 'chart' })).toBe('wide')
    expect(widgetSize({ kind: 'stat', size: 'wide' })).toBe('wide')
  })

  it('steps the column count down as the page narrows', () => {
    expect([gridColumns(960), gridColumns(720), gridColumns(600), gridColumns(460), gridColumns(300)]).toEqual([3, 3, 2, 2, 1])
  })

  it('spans every column for a wide card and one for a small one', () => {
    expect(cardSpan('wide', 3)).toBe(3)
    expect(cardSpan('small', 3)).toBe(1)
  })
})

describe('chartRange and chartGeometry', () => {
  it('pads a flat series so the line sits mid-chart', () => {
    expect(chartRange([{ label: 'Open', points: [4, 4, 4] }])).toEqual({ yMin: 3, yMax: 5 })
  })

  it('takes the range of every point across series', () => {
    const series = [
      { label: 'Open', points: [2, 9] },
      { label: 'Closed', points: [5, 1] }
    ]
    expect(chartRange(series)).toEqual({ yMin: 1, yMax: 9 })
  })

  it('draws one path per series, in its colour, with an area under the first', () => {
    const g = chartGeometry(
      [
        { label: 'Open', points: [0, 10] },
        { label: 'Closed', points: [10, 0] }
      ],
      600,
      160
    )
    expect(g.lines.map((l) => l.label)).toEqual(['Open', 'Closed'])
    expect(g.lines[0]!.d).toBe('M0 160 L600 0')
    expect(g.lines[1]!.d).toBe('M0 0 L600 160')
    expect(g.lines[0]!.color).toBe('var(--accent-text)')
    expect(g.area).toBe('M0 160 L600 0 L600 160 L0 160 Z')
    expect([g.yMin, g.yMax]).toEqual([0, 10])
  })

  it('draws nothing for an empty series', () => {
    expect(chartGeometry([], 600, 160)).toEqual({ lines: [], area: '', yMin: 0, yMax: 1 })
  })
})

describe('timeAgo', () => {
  it('reads the age in the largest unit that fits', () => {
    expect(timeAgo(new Date(NOW - 20_000).toISOString(), NOW)).toBe('just now')
    expect(timeAgo(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3m ago')
    expect(timeAgo(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe('2h ago')
    expect(timeAgo(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe('5d ago')
  })

  it('is empty for a missing or unreadable time', () => {
    expect(timeAgo(null, NOW)).toBe('')
    expect(timeAgo('not a time', NOW)).toBe('')
  })
})

describe('removeBody, isWebLink, progressPercent', () => {
  it('asks the daemon to remove one widget by id', () => {
    expect(removeBody('C:/Users/me/atlas', 'w-7')).toEqual({ cwd: 'C:/Users/me/atlas', remove: ['w-7'] })
  })

  it('opens http and https links in the browser and reveals anything else', () => {
    expect(isWebLink('https://example.test/issue/4')).toBe(true)
    expect(isWebLink(' http://example.test ')).toBe(true)
    expect(isWebLink('C:/Users/me/atlas/notes.md')).toBe(false)
    expect(isWebLink('file:///C:/x')).toBe(false)
  })

  it('clamps a progress bar between 0 and 100 and survives a missing max', () => {
    expect(progressPercent(3, 4)).toBe(75)
    expect(progressPercent(9, 4)).toBe(100)
    expect(progressPercent(-1, 4)).toBe(0)
    expect(progressPercent(3, 0)).toBe(0)
    expect(progressPercent(undefined, 4)).toBe(0)
  })
})

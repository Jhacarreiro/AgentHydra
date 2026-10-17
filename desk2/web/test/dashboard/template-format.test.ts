// What the template page says about its numbers: how fresh they are (amber once their source has missed two and a half
// of its rounds, or its last read failed), a row's age, a tile that was not measured, and which folders have one.
import { describe, expect, it } from 'bun:test'
import type { ProjectDashboard, SourceState } from '@shared/project-dashboard'
import { hasDashboard } from '@/components/dashboard/logic'
import { age, freshness, sharedReasons, tileValue } from '@/components/dashboard/template/format'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const min = (n: number) => new Date(NOW - n * 60_000).toISOString()
const source = (over: Partial<SourceState>): SourceState => ({ id: 's', label: 'HTTP api.example.com', fetchedAt: null, generatedAt: null, everyMinutes: null, error: null, reading: false, ...over })
const dash = (sources: SourceState[]): ProjectDashboard => ({ version: '1', workspace: 'C:/Users/me/atlas', specFile: '', title: 'Atlas', refreshMinutes: 5, ranges: [], sections: [], sources, problems: [] })

describe('freshness', () => {
  it('goes by the oldest source, and is late past two and a half of that source rounds', () => {
    const d = dash([source({ generatedAt: min(12), everyMinutes: 30 }), source({ fetchedAt: min(2) })])
    expect(freshness(d, NOW)).toMatchObject({ text: 'Updated 12 min ago', late: false })
    expect(freshness(dash([source({ generatedAt: min(80), everyMinutes: 30 })]), NOW)).toMatchObject({ text: 'Updated 1 h ago', late: true })
  })

  it('is late when a read failed, and its tooltip names the source and why', () => {
    const f = freshness(dash([source({ fetchedAt: min(1), error: 'api.example.com answered HTTP 503' })]), NOW)
    expect(f.late).toBe(true)
    expect(f.tip.split('\n').slice(1)).toEqual(['HTTP api.example.com: api.example.com answered HTTP 503'])
  })
})

it("a row's age and a tile's value read as the person reads them", () => {
  expect([age(min(30), NOW), age(min(3 * 1440 + 5), NOW), age(min(100 * 1440), NOW), age(null, NOW)]).toEqual(['today', '3d', '14w', ''])
  expect([tileValue({ label: 'Visitors', value: 2915 }), tileValue({ label: 'Signups', value: null, atLeast: 50 }), tileValue({ label: 'Sent', value: null })]).toEqual(['2,915', '50+', '–'])
})

it('a folder inside a checkout with a spec has a dashboard', () => {
  expect(hasDashboard([], ['C:/Users/me/atlas'], 'c:\\users\\me\\atlas\\web')).toBe(true)
  expect(hasDashboard([], ['C:/Users/me/atlas'], 'C:/Users/me/atlas-two')).toBe(false)
})

it('a source that could not be read is said once for all its sections; a reason only one section has stays with it', () => {
  const down = 'Could not read HTTP api.example.com: api.example.com answered HTTP 503'
  const sections = [{ missing: down }, { missing: null }, { missing: down }, { missing: 'HTTP api.example.com has no todo in its answer' }]
  expect(sharedReasons(sections)).toEqual([down])
})

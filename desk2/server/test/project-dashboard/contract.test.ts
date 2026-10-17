// The dashboard template's contract (shared/project-dashboard.ts) is what every provider writes to: Connections' feed,
// any stranger's endpoint, and the spec a project keeps. These hold what a provider is told when its answer does not
// fit, and that one bad row or section costs only itself.

import { describe, expect, test } from 'bun:test'
import { checkFeed, checkSectionFeed, checkSpec, forRange } from '@shared/project-dashboard'

describe('checkSpec', () => {
  test('a one-source spec needs no source per section; a bad section is named and the good ones still draw', () => {
    const { spec, problems } = checkSpec({
      title: 'Atlas',
      sources: { main: { http: { url: 'https://api.example.com/dashboard' } } },
      sections: [
        { id: 'numbers', type: 'stats', title: 'Numbers' },
        { id: 'numbers', type: 'list', title: 'Again' },
        { id: 'chart', type: 'pie', title: 'Pie' },
        { id: 'todo', type: 'list', title: 'Waiting on you', attention: true, show: 3 }
      ]
    })
    expect(spec?.sections.map((s) => [s.id, s.source])).toEqual([
      ['numbers', 'main'],
      ['todo', 'main']
    ])
    expect(problems).toEqual(['sections[1].id numbers is used twice', 'sections[2].type must be one of stats, list, errors, breakdown'])
  })

  test('with two sources each section must name one, and a source must be mcp or http', () => {
    const { spec, problems } = checkSpec({
      sources: { a: { mcp: { server: 'local', tool: 'dashboard' } }, b: { http: { url: 'https://api.example.com/feed' } }, c: { ftp: 'x' } },
      sections: [
        { id: 'one', type: 'stats', title: 'One' },
        { id: 'two', type: 'stats', title: 'Two', source: 'a' }
      ]
    })
    expect(spec?.sections.map((s) => s.id)).toEqual(['two'])
    expect(problems).toEqual(['sources.c must have mcp {server, tool, arguments} or http {url, headers}', 'sections[0].source must name one of the sources (a, b)'])
  })
})

describe('a section feed', () => {
  test('a stats answer per range keeps each range, a range it cannot read says why, and an unknown range is named', () => {
    const { feed, problems } = checkSectionFeed(
      'stats',
      {
        ranges: {
          today: { tiles: [{ label: 'Visitors', value: 12, change: -5 }] },
          '7d': { tiles: [{ label: 'Visitors', value: '638' }] },
          '30d': { missing: 'the analytics service is down' },
          week: { tiles: [] }
        }
      },
      'sections.hero'
    )
    expect(forRange(feed, 'today')).toEqual({ tiles: [{ label: 'Visitors', value: 12, change: -5 }] })
    expect(forRange(feed, '30d')).toEqual({ missing: 'the analytics service is down' })
    // A tile that does not fit is left out of its range; the range still draws its other tiles.
    expect(forRange(feed, '7d')).toEqual({ tiles: [] })
    expect(problems).toEqual(['sections.hero.ranges.7d.tiles[0].value must be a number, or null when not measured', 'sections.hero.ranges.week is not a range: use today, 7d, 30d'])
  })

  test('one bad row costs that row; a section with no rows list cannot draw', () => {
    const list = checkSectionFeed('list', { items: [{ title: 'Call the bank', since: '2026-10-01T09:00:00Z', priority: 1 }, { title: '' }], total: 40 }, 's')
    expect(list.feed).toEqual({ items: [{ title: 'Call the bank', since: '2026-10-01T09:00:00Z', priority: 1 }], total: 40 })
    expect(list.problems).toEqual(['s.items[1].title must be text of up to 500 characters'])

    const errors = checkSectionFeed('errors', { open: 3 }, 's')
    expect(errors.feed).toBeNull()
    expect(errors.problems).toEqual(['s.groups must be a list'])
  })
})

test('a feed must carry sections, and says which format it is when it names one', () => {
  expect(checkFeed({ sections: {}, generatedAt: '2026-10-17T09:00:00Z', everyMinutes: 30 })).toEqual({
    ok: true,
    value: { format: 'agenthydra-dashboard/1', sections: {}, generatedAt: '2026-10-17T09:00:00Z', everyMinutes: 30 },
    problems: []
  })
  expect(checkFeed({ format: 'hydra-data/1', sections: {} })).toEqual({ ok: false, problems: ['format must be agenthydra-dashboard/1'] })
  expect(checkFeed([])).toEqual({ ok: false, problems: ['the answer must be a JSON object'] })
})

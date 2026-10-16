import { describe, expect, test } from 'bun:test'
import type { StarterManager } from '@shared/people'
import { authorityBrief, buildRequest, initials, isBlank } from '../../src/components/people/logic'

const starters: StarterManager[] = [
  { slug: 'a', name: 'Example One', title: 'Role A', oneLiner: 'x', brief: 'b' },
  { slug: 'b', name: 'Example Two', title: 'Role B', oneLiner: 'y', brief: 'c' },
]
const form = { authorityName: '', authorityHow: '', authorityRulings: '', picked: [] as string[], added: [] as { name: string; title: string }[] }

describe('people form', () => {
  test('an empty form is blank and saves nothing', () => {
    expect(isBlank(buildRequest(form, starters))).toBe(true)
  })
  test('keeps only picked starters and named additions', () => {
    const req = buildRequest({ ...form, picked: ['b'], added: [{ name: ' Pat Doe ', title: 'Writer' }, { name: '  ', title: 'x' }] }, starters)
    expect(req.managers.map((m) => m.name)).toEqual(['Example Two', 'Pat Doe'])
    expect(isBlank(req)).toBe(false)
  })
  test('rulings go under their own heading in the authority brief', () => {
    expect(authorityBrief('Decides fast.', '')).toBe('Decides fast.')
    expect(authorityBrief('Decides fast.', 'No Friday deploys.')).toBe('Decides fast.\n\n## Rulings\n\nNo Friday deploys.')
    expect(buildRequest({ ...form, authorityName: 'Example Owner' }, starters).authority?.name).toBe('Example Owner')
  })
  test('initials', () => {
    expect(initials('Riley Hart')).toBe('RH')
    expect(initials('  ')).toBe('')
  })
})

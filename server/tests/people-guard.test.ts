import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
// @ts-expect-error plain .mjs shared with the pre-commit hook
import { FIXTURES_DIR, inspect, scan } from '../../.githooks/check-people.mjs'

describe('people guard', () => {
  test('no tracked file carries people content', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\n')
      .filter(Boolean)
    const hits: { file: string; why: string }[] = scan(files)
    expect(hits.map((h) => `${h.file}: ${h.why}`)).toEqual([])
  }, 60_000)

  test('a persona outside the fixtures folder is refused, inside it is allowed', () => {
    const persona = Buffer.from(
      JSON.stringify({ name: 'Ada Example', oneLiner: 'x', keywords: ['a'] }),
    )
    expect(inspect('docs/x/other.json', () => persona, new Set())).toContain('persona')
    expect(inspect(`${FIXTURES_DIR}ada/persona.json`, () => persona, new Set())).toBeNull()
  }, 60_000)

  test('portraits and rosters are refused', () => {
    expect(inspect('web/portraits/ada.png', () => null, new Set())).toBe('portrait image')
    expect(inspect('x/roster.json', () => Buffer.from('[]'), new Set())).toBe('roster dump')
  }, 60_000)
})

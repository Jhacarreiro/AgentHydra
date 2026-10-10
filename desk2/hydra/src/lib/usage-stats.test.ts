import { expect, test } from 'bun:test'
import type { SpendBucket, SpendReport } from '@agenthydra/server/types'
import { summarizeUsage } from './usage-stats'

const bucket = (key: string, weighted: number, sessions: number, turns: number): SpendBucket =>
  ({ key, weighted, costUsd: null, sessions, turns })
const report = (totalWeighted: number, sessions: number, byModel: SpendBucket[]): SpendReport =>
  ({ totalWeighted, sessions, byModel }) as SpendReport

test('CLI and CliMayte merge by model: one row per model, its tokens, sessions and turns added up', () => {
  const cli = report(300, 3, [bucket('example-large', 200, 2, 5), bucket('example-small', 100, 1, 2)])
  const climayte = report(150, 2, [bucket('example-large', 150, 2, 4)])
  const s = summarizeUsage([cli, climayte])
  expect(s.models).toEqual([
    { model: 'example-large', tokens: 350, sessions: 4, turns: 9 },
    { model: 'example-small', tokens: 100, sessions: 1, turns: 2 },
  ])
  expect(s).toMatchObject({ tokens: 450, sessions: 5, turns: 11 })
})

test('models list the most tokens first, whatever order the report gives them in', () => {
  const s = summarizeUsage([report(90, 3, [bucket('example-b', 10, 1, 1), bucket('example-a', 50, 1, 1), bucket('example-c', 30, 1, 1)])])
  expect(s.models.map((m) => m.model)).toEqual(['example-a', 'example-c', 'example-b'])
})

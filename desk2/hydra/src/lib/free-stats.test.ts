import { expect, test } from 'bun:test'
import type { FreeInstance, FreeStatRow } from '@desk/shared/free-instances'
import { summarizeFree } from './free-stats'

const account = (id: string, num: number, provider: FreeInstance['provider']): FreeInstance =>
  ({ id, num, provider, name: `Example ${num}`, autoName: false, loggedIn: true, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null })

test('Free numbers: tokens by provider over the period (the days the header adds up), success by model, model-less failures off the model list', () => {
  const now = new Date(2026, 9, 8, 12).getTime()
  const instances = [account('b', 2, 'chatgpt'), account('a', 1, 'claude'), account('c', 3, 'chatgpt')]
  const row = (day: string, instanceId: string, model: string, sent: number, failed: number, input: number, why?: Record<string, number>): FreeStatRow =>
    ({ day, instanceId, model, sent, failed, input, output: 0, ...(why ? { why } : {}) })
  const rows = [
    row('2026-10-07', 'a', '', 0, 0, 500),
    row('2026-10-08', 'a', 'claude-haiku', 4, 1, 40),
    row('2026-10-08', 'b', 'gpt-6', 3, 0, 30),
    row('2026-10-08', 'c', 'gpt-6', 2, 2, 0, { rate_limited: 2 }),
    // A send that failed before a model was picked: in the totals, not a model (as older days recorded it, and as now).
    row('2026-10-08', 'c', 'unknown', 1, 1, 0),
    row('2026-10-08', 'b', '', 1, 1, 0, { not_found: 1 }),
    // An account removed since: on no total, line or day.
    row('2026-10-08', 'gone', 'gpt-6', 9, 0, 900),
    // A day before the period: a read made for a longer period can still hold it.
    row('2026-10-01', 'a', '', 0, 0, 7000),
  ]
  const s = summarizeFree(rows, instances, 3, now)

  // Each failure's code is summed where its failure is, a model-less one in the totals only. The tiles' tokens are the
  // period's, never the table's 5-hour or weekly window (2026-10-17: they read "this week" under any period).
  const why = { rate_limited: 2, not_found: 1 }
  expect(s.totals).toEqual({ all: { tokens: 570, sent: 11, failed: 5, why }, claude: { tokens: 540, sent: 4, failed: 1, why: {} }, chatgpt: { tokens: 30, sent: 7, failed: 4, why } })
  expect(s.totals.all.tokens).toBe(s.days.reduce((n, d) => n + d.claude + d.chatgpt, 0))
  expect(s.models.map(m => [m.provider, m.model, m.sent, m.failed, m.tokens, m.why])).toEqual([
    ['chatgpt', 'gpt-6', 5, 2, 30, { rate_limited: 2 }], ['claude', 'claude-haiku', 4, 1, 40, {}]])
  expect(s.days).toEqual([{ key: '2026-10-06', claude: 0, chatgpt: 0 }, { key: '2026-10-07', claude: 500, chatgpt: 0 }, { key: '2026-10-08', claude: 40, chatgpt: 30 }])
})

import { describe, expect, it } from 'bun:test'
import type { CMInstance } from '@/lib/api'
import { RESOLVED_REFRESH_MS, UNCONFIRMED_RUNNING_RETRY_MS, resolveDue } from './account-resolve'

type Row = Pick<CMInstance, 'account' | 'loginUuid' | 'isRunning'>
const row = (status: string, isRunning: boolean): Row =>
  ({ isRunning, loginUuid: 'u-1', account: { email: 'a@example.com', accountUuid: 'u-1', status } }) as unknown as Row

// 2026-10-16, owner: a profile kept its "login couldn't be confirmed" mark after he signed it back in, because a row
// that shows an account was asked again only every quarter hour.
describe('resolveDue', () => {
  it('asks again within seconds while an unconfirmed login runs', () => {
    expect(resolveDue(row('cache', true), UNCONFIRMED_RUNNING_RETRY_MS)).toBe(true)
    expect(resolveDue(row('offline', true), UNCONFIRMED_RUNNING_RETRY_MS)).toBe(true)
    expect(UNCONFIRMED_RUNNING_RETRY_MS).toBeLessThanOrEqual(15_000)
  })
  it('keeps the slow re-check for a confirmed login and for a closed app', () => {
    expect(resolveDue(row('live', true), UNCONFIRMED_RUNNING_RETRY_MS)).toBe(false)
    expect(resolveDue(row('cache', false), UNCONFIRMED_RUNNING_RETRY_MS)).toBe(false)
    expect(resolveDue(row('cache', false), RESOLVED_REFRESH_MS)).toBe(true)
  })
})

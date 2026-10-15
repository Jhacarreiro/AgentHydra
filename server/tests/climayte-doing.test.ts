import { describe, expect, test } from 'bun:test'
import { doingOf, stateKey } from '../src/climayte-doing'
import type { CliMayteWorker } from '../src/climayte-lib'

const worker = (over: Partial<CliMayteWorker>): CliMayteWorker =>
  ({
    status: 'queued',
    error: null,
    lastActivity: null,
    createdAt: 1_000,
    ...over,
  }) as CliMayteWorker

describe('doingOf', () => {
  test('a worker held for CPU says the reason, since the hold began', () => {
    const w = worker({
      status: 'queued',
      error: 'Waiting for CPU: 99% busy over the last 30 s. Nothing running is stopped.',
      stateAt: { key: 'queued|Waiting for CPU', at: 5_000 },
    })
    expect(doingOf(w)).toEqual({
      doing: 'Waiting for CPU: 99% busy over the last 30 s',
      doingSince: 5_000,
    })
  })

  test('a running worker says its newest line, since that line last changed', () => {
    const w = worker({
      status: 'running',
      lastActivity: 'Bash bun test ./server/tests',
      stepAt: 9_000,
      stateAt: { key: 'running', at: 4_000 },
    })
    expect(doingOf(w)).toEqual({ doing: 'Bash bun test ./server/tests', doingSince: 9_000 })
  })

  test('a running worker that has not moved since it started counts from the start', () => {
    const w = worker({
      status: 'running',
      lastActivity: 'said: reading the diff',
      stepAt: 2_000,
      stateAt: { key: 'running', at: 4_000 },
    })
    expect(doingOf(w).doingSince).toBe(4_000)
  })

  test('a finished worker has nothing to say', () => {
    expect(doingOf(worker({ status: 'done' }))).toEqual({ doing: null, doingSince: null })
  })

  test('a long line is cut to 120 characters', () => {
    const w = worker({ status: 'running', lastActivity: `said: ${'x'.repeat(300)}` })
    expect(doingOf(w).doing!.length).toBe(120)
    expect(doingOf(w).doing!.endsWith('...')).toBe(true)
  })
})

describe('stateKey', () => {
  test('a held worker keeps its key while the figures in its reason change', () => {
    const a = worker({
      status: 'queued',
      error: 'Waiting for CPU: 99% busy over the last 30 s. Nothing running is stopped.',
    })
    const b = worker({
      status: 'queued',
      error: 'Waiting for CPU: 40% busy over the last 30 s. Nothing running is stopped.',
    })
    expect(stateKey(a)).toBe(stateKey(b))
    expect(stateKey(a)).not.toBe(
      stateKey(worker({ status: 'queued', error: 'Waiting for memory: 2 GB free. It starts.' })),
    )
  })

  test('a running worker is keyed by its status alone', () => {
    expect(stateKey(worker({ status: 'running', lastActivity: 'Bash ls' }))).toBe('running')
  })
})

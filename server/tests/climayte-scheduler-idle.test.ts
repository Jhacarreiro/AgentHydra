import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { InstallState } from '../src/claude-install-guard'
import { load, setCliMayteCpuReader, setCliMayteMemoryReader, workers } from '../src/climayte-core'
import { resetCpuRing } from '../src/climayte-cpu'
import type { CliMayteAccount, CliMayteWorker } from '../src/climayte-lib'
import { setLaunchPacing } from '../src/climayte-pacing'
import {
  scheduleDue,
  scheduleTick,
  setInstallGuard,
  setLauncher,
  tickState,
} from '../src/climayte-schedule'

const T = 1_800_000_000_000
const accounts: CliMayteAccount[] = Array.from({ length: 7 }, (_, n) => ({
  id: `idle-account-${n}`,
  num: n + 1,
  name: 'Example',
  configDir: '/synthetic',
  sessionPct: 5,
  weekPct: 5,
  planFactor: 20,
}))
const healthy: InstallState = {
  ok: true,
  reason: null,
  version: 'synthetic',
  exe: '/synthetic/claude',
  usingLastKnownGood: false,
  repairing: false,
  nextRepairAt: null,
}
let saved: Array<[string, CliMayteWorker]> = []
let launched: string[] = []
let probes = 0
beforeEach(() => {
  load()
  saved = [...workers]
  workers.clear()
  launched = []
  probes = 0
  resetCpuRing()
  setLaunchPacing(false)
  setCliMayteCpuReader(null)
  setCliMayteMemoryReader(null)
  setInstallGuard(() => {
    probes++
    return healthy
  })
  setLauncher((w, account) => {
    w.status = 'running'
    w.accountId = account.id
    launched.push(w.id)
  })
})
afterEach(() => {
  workers.clear()
  for (const [id, w] of saved) workers.set(id, w)
  setInstallGuard(null)
  setLauncher(null)
  setCliMayteCpuReader(null)
  setCliMayteMemoryReader(null)
  resetCpuRing()
  setLaunchPacing(false)
})

function put(id: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker {
  const w: CliMayteWorker = {
    id,
    group: `idle-${id}`,
    title: id,
    cwd: '/synthetic',
    prompt: 'synthetic task',
    pending: [],
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    accounts: null,
    status: 'queued',
    sessionId: null,
    accountId: null,
    attempts: [],
    result: null,
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  }
  workers.set(id, w)
  return w
}
function coldHistory(n: number) {
  for (let i = 0; i < n; i++) {
    const w = put(`idle-history-${i}`, { status: 'done' })
    Object.defineProperty(w, 'model', {
      enumerable: true,
      get() {
        throw new Error('Idle scheduling read historical placement fields.')
      },
    })
  }
}

describe('CliMayte no-due scheduler', () => {
  test('17425 finished workers and held/deferred work do no placement or memory reads while CPU sampling continues', () => {
    coldHistory(17425)
    put('idle-held', { hold: 'wave' })
    put('idle-deferred', { notBefore: T + 100_000 })
    let cpuReads = 0
    let memoryReads = 0
    setCliMayteCpuReader(() => {
      cpuReads++
      return { idle: 1000, total: 1000 }
    })
    setCliMayteMemoryReader(() => {
      memoryReads++
      return null
    })
    for (let n = 0; n < 20; n++) expect(scheduleTick(accounts, T + n * 1000)).toBeUndefined()
    expect(cpuReads).toBe(20)
    expect(memoryReads).toBe(0)
    expect(probes).toBe(0)
    expect(launched).toEqual([])
  })

  test('due work keeps exactly the prior account choices, priority order and held/deferred behavior', async () => {
    const fixture = () => [
      put('idle-low', { priority: 0 }),
      put('idle-high', { priority: 9 }),
      put('idle-person', {
        chat: true,
        attempts: [
          {
            account: accounts[0]!,
            startedAt: T - 10,
            endedAt: T - 1,
            outcome: 'done',
            pid: null,
            log: '/synthetic/prior',
            errLog: '/synthetic/prior.err',
            notice: null,
            resumed: false,
          },
        ],
      }),
      put('idle-held', { hold: 'wave' }),
      put('idle-future', { notBefore: T + 1 }),
    ]
    const before = fixture()
    scheduleDue(
      tickState(accounts, T, healthy),
      before.filter((w) => !w.hold && (w.notBefore ?? 0) <= T),
    )
    const expected = {
      launched: [...launched],
      statuses: before.map((w) => [w.id, w.status, w.accountId]),
    }
    workers.clear()
    launched = []
    resetCpuRing()
    const after = fixture()
    await scheduleTick(accounts, T)
    expect({ launched, statuses: after.map((w) => [w.id, w.status, w.accountId]) }).toEqual(
      expected,
    )
    expect(probes).toBe(1)
    expect(workers.get('idle-held')!.status).toBe('queued')
    expect(workers.get('idle-future')!.status).toBe('queued')
  })

  test('a probe re-reads the due list after cancellations, holds, removals and new work', async () => {
    let finish!: (value: InstallState) => void
    setInstallGuard(
      () =>
        new Promise<InstallState>((resolve) => {
          finish = resolve
        }),
    )
    const cancelled = put('idle-cancelled')
    const held = put('idle-newhold')
    const removed = put('idle-removed')
    const pending = scheduleTick(accounts, T)
    expect(pending).toBeDefined()
    cancelled.status = 'cancelled'
    held.hold = 'wave'
    workers.delete(removed.id)
    put('idle-new', { priority: 5 })
    finish(healthy)
    await pending
    expect(launched).toEqual(['idle-new'])
    expect(cancelled.status).toBe('cancelled')
    expect(held.status).toBe('queued')
  })

  test('a probe whose last due task was cancelled skips history and still samples CPU', async () => {
    coldHistory(2000)
    let finish!: (value: InstallState) => void
    let cpuReads = 0
    setCliMayteCpuReader(() => {
      cpuReads++
      return { idle: 1, total: 1 }
    })
    setInstallGuard(
      () =>
        new Promise<InstallState>((resolve) => {
          finish = resolve
        }),
    )
    const w = put('idle-cancel-last')
    const pending = scheduleTick(accounts, T)
    w.status = 'cancelled'
    finish(healthy)
    await pending
    expect(cpuReads).toBe(1)
    expect(launched).toEqual([])
  })

  test('CPU warmed by no-due ticks holds new ordinary work while busy and releases it when quiet', async () => {
    let counters = { idle: 0, total: 0 }
    setCliMayteCpuReader(() => counters)
    for (let n = 0; n <= 10; n++) {
      counters = { idle: n * 300, total: n * 3000 }
      expect(scheduleTick(accounts, T + n * 3000)).toBeUndefined()
    }
    for (let n = 0; n < 4; n++)
      put(`idle-running-${n}`, { status: 'running', accountId: accounts[n]!.id })
    const w = put('idle-cpu-queued')
    await scheduleTick(accounts, T + 30_000)
    expect(w.status).toBe('queued')
    expect(w.error).toContain('Waiting for CPU: 90% busy')
    expect(launched).toEqual([])
    counters = { idle: counters.idle + 1_000_000, total: counters.total + 1_000_000 }
    await scheduleTick(accounts, T + 33_000)
    expect(w.status).toBe('running')
    expect(launched).toEqual([w.id])
  })
})

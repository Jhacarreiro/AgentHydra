import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  autoUpdateEnabled,
  relaunchAfterUpdate,
  runAutoUpdateOnce,
  setAutoUpdateEnabled,
  setAutoUpdateHooks,
  startAutoUpdate,
  stopAutoUpdate,
} from '../src/auto-update'
import { FreeBatchLifecycle } from '../src/free-batch-lifecycle'
import type { UpdateApplyResult, UpdateStatus } from '../src/updater-engine.mjs'

afterEach(() => {
  stopAutoUpdate()
  setAutoUpdateHooks({})
})

function status(): UpdateStatus {
  return {
    ok: true,
    service: 'agenthydra',
    currentVersion: '2.0.4',
    currentCommit: 'old',
    remoteCommit: 'new',
    branch: 'main',
    upstream: 'origin/main',
    remote: 'origin',
    dirty: false,
    updateAvailable: true,
    canApply: true,
    checkedAt: 0,
    reason: null,
  }
}
function applied(): UpdateApplyResult {
  return { ok: true, message: 'updated', restartRequired: true, status: status(), output: [] }
}

test('volatile work is a hard gate even beyond the soft one-hour defer', async () => {
  const lifecycle = new FreeBatchLifecycle()
  const release = lifecycle.acquire()
  let applies = 0
  let restarts = 0
  setAutoUpdateHooks({
    check: async () => status(),
    apply: async () => {
      applies++
      return applied()
    },
    hasUnsafeWork: () => lifecycle.activeCount() > 0,
    hasActiveRuns: () => true,
    relaunch: () => {
      restarts++
    },
  })
  expect((await runAutoUpdateOnce(1)).reason).toBe('volatile-work')
  expect((await runAutoUpdateOnce(10_000_000)).reason).toBe('volatile-work')
  expect([applies, restarts]).toEqual([0, 0])
  release()
})

test('work begun during apply defers restart, then hands over without another check or apply', async () => {
  const lifecycle = new FreeBatchLifecycle()
  let release!: () => void
  let checks = 0
  let applies = 0
  let restarts = 0
  setAutoUpdateHooks({
    check: async () => {
      checks++
      return status()
    },
    apply: async () => {
      applies++
      release = lifecycle.acquire()
      return applied()
    },
    hasUnsafeWork: () => lifecycle.activeCount() > 0,
    relaunch: () => {
      restarts++
      return lifecycle.beginRestart()
    },
  })
  expect(await runAutoUpdateOnce()).toMatchObject({
    applied: true,
    relaunched: false,
    reason: 'restart-pending',
  })
  expect((await runAutoUpdateOnce()).relaunched).toBe(false)
  expect([checks, applies, restarts]).toEqual([1, 1, 0])
  release()
  expect(await runAutoUpdateOnce()).toMatchObject({
    checked: false,
    applied: false,
    relaunched: true,
  })
  expect([checks, applies, restarts]).toEqual([1, 1, 1])
  expect(() => lifecycle.acquire()).toThrow('restarting')
})

test('new work cannot enter while an asynchronous successor handshake is pending', async () => {
  const lifecycle = new FreeBatchLifecycle()
  let ready!: (ok: boolean) => void
  let attempts = 0
  setAutoUpdateHooks({
    hasUnsafeWork: () => lifecycle.activeCount() > 0,
    relaunch: () => {
      attempts++
      expect(lifecycle.beginRestart()).toBe(true)
      return new Promise<boolean>((resolve) => {
        ready = resolve
      })
    },
  })
  const handoff = relaunchAfterUpdate()
  const sameHandoff = relaunchAfterUpdate()
  await Promise.resolve()
  expect(() => lifecycle.acquire()).toThrow('No Free task was started')
  expect(attempts).toBe(1)
  ready(true)
  expect(await handoff).toBe(true)
  expect(await sameHandoff).toBe(true)
})

test('a failed handoff remains pending and retries without reinstalling', async () => {
  let attempts = 0
  let checks = 0
  setAutoUpdateHooks({
    check: async () => {
      checks++
      return status()
    },
    relaunch: () => ++attempts > 1,
  })
  expect(await relaunchAfterUpdate()).toBe(false)
  expect((await runAutoUpdateOnce()).relaunched).toBe(true)
  expect([attempts, checks]).toEqual([2, 0])
})

test('deferred manual source updates keep their original restart guard after Free work finishes', async () => {
  const lifecycle = new FreeBatchLifecycle()
  const release = lifecycle.acquire()
  let sourceWorkActive = true
  let restarts = 0
  setAutoUpdateHooks({
    hasUnsafeWork: () => lifecycle.activeCount() > 0,
    relaunch: () => {
      restarts++
      return lifecycle.beginRestart()
    },
  })
  expect(await relaunchAfterUpdate(() => !sourceWorkActive)).toBe(false)
  release()
  expect((await runAutoUpdateOnce()).relaunched).toBe(false)
  expect(restarts).toBe(0)
  sourceWorkActive = false
  expect((await runAutoUpdateOnce()).relaunched).toBe(true)
  expect(restarts).toBe(1)
})

test('work admitted between the readiness check and handoff reservation prevents shutdown', async () => {
  const lifecycle = new FreeBatchLifecycle()
  setAutoUpdateHooks({
    hasUnsafeWork: () => lifecycle.activeCount() > 0,
    relaunch: () => lifecycle.beginRestart(),
  })
  const handoff = relaunchAfterUpdate()
  const release = lifecycle.acquire()
  expect(await handoff).toBe(false)
  expect(lifecycle.activeCount()).toBe(1)
  release()
  expect((await runAutoUpdateOnce()).relaunched).toBe(true)
})

test('a thrown handoff remains pending rather than reporting an applied update as failed', async () => {
  let attempts = 0
  setAutoUpdateHooks({
    check: async () => status(),
    apply: async () => applied(),
    relaunch: () => {
      if (++attempts === 1) throw new Error('synthetic unavailable successor')
      return true
    },
  })
  expect(await runAutoUpdateOnce()).toMatchObject({
    applied: true,
    relaunched: false,
    reason: 'restart-pending',
  })
  expect((await runAutoUpdateOnce()).relaunched).toBe(true)
})

test('a requested manual update retries its pending handoff promptly while auto-apply is off', async () => {
  const lifecycle = new FreeBatchLifecycle()
  const release = lifecycle.acquire()
  const wasEnabled = autoUpdateEnabled()
  const timers = spyOn(globalThis, 'setTimeout')
  let applies = 0
  try {
    setAutoUpdateEnabled(false)
    setAutoUpdateHooks({
      hasUnsafeWork: () => lifecycle.activeCount() > 0,
      apply: async () => {
        applies++
        return applied()
      },
      relaunch: () => lifecycle.beginRestart(),
    })
    startAutoUpdate()
    expect(await relaunchAfterUpdate()).toBe(false)
    expect(timers.mock.calls.at(-1)?.[1]).toBe(5000)
    release()
    expect((await runAutoUpdateOnce()).relaunched).toBe(true)
    expect(applies).toBe(0)
    expect(autoUpdateEnabled()).toBe(false)
  } finally {
    release()
    stopAutoUpdate()
    timers.mockRestore()
    setAutoUpdateEnabled(wasEnabled)
  }
})

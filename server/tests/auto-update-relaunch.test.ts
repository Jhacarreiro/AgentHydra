// server/tests/auto-update-relaunch.test.ts: an applied update's restart is retried until it hands over,
// never applying the same update twice. A manual source apply's guard (index.ts restartRefusal: a CliMayte
// worker the daemon spawned itself) holds the restart until it lets go.
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

test('a second restart request while a successor handshake is pending shares it', async () => {
  let ready!: (ok: boolean) => void
  let attempts = 0
  setAutoUpdateHooks({
    relaunch: () => {
      attempts++
      return new Promise<boolean>((resolve) => {
        ready = resolve
      })
    },
  })
  const handoff = relaunchAfterUpdate()
  const sameHandoff = relaunchAfterUpdate()
  await Promise.resolve()
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

test('a deferred manual source update keeps its restart guard until the guard lets go', async () => {
  let workerInside = true
  let restarts = 0
  setAutoUpdateHooks({
    relaunch: () => {
      restarts++
      return true
    },
  })
  expect(await relaunchAfterUpdate(() => !workerInside)).toBe(false)
  expect((await runAutoUpdateOnce()).relaunched).toBe(false)
  expect(restarts).toBe(0)
  workerInside = false
  expect((await runAutoUpdateOnce()).relaunched).toBe(true)
  expect(restarts).toBe(1)
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
  let workerInside = true
  const wasEnabled = autoUpdateEnabled()
  const timers = spyOn(globalThis, 'setTimeout')
  let applies = 0
  try {
    setAutoUpdateEnabled(false)
    setAutoUpdateHooks({
      apply: async () => {
        applies++
        return applied()
      },
      relaunch: () => true,
    })
    startAutoUpdate()
    expect(await relaunchAfterUpdate(() => !workerInside)).toBe(false)
    expect(timers.mock.calls.at(-1)?.[1]).toBe(5000)
    workerInside = false
    expect((await runAutoUpdateOnce()).relaunched).toBe(true)
    expect(applies).toBe(0)
    expect(autoUpdateEnabled()).toBe(false)
  } finally {
    stopAutoUpdate()
    timers.mockRestore()
    setAutoUpdateEnabled(wasEnabled)
  }
})

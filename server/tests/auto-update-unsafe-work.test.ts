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
/** Work a restart would lose (a chat move, orchestrator.ts moveRestartRefusal), as the daemon wires hasUnsafeWork. */
function unsafeWork() {
  let n = 0
  return {
    begin: () => {
      n++
      let ended = false
      return () => {
        if (!ended) n--
        ended = true
      }
    },
    running: () => n > 0,
  }
}
function applied(): UpdateApplyResult {
  return { ok: true, message: 'updated', restartRequired: true, status: status(), output: [] }
}

test('volatile work is a hard gate even beyond the soft one-hour defer', async () => {
  const work = unsafeWork()
  const release = work.begin()
  let applies = 0
  let restarts = 0
  setAutoUpdateHooks({
    check: async () => status(),
    apply: async () => {
      applies++
      return applied()
    },
    hasUnsafeWork: work.running,
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
  const work = unsafeWork()
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
      release = work.begin()
      return applied()
    },
    hasUnsafeWork: work.running,
    relaunch: () => {
      restarts++
      return true
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
})

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

test('deferred manual source updates keep their original restart guard after unsafe work finishes', async () => {
  const work = unsafeWork()
  const release = work.begin()
  let sourceWorkActive = true
  let restarts = 0
  setAutoUpdateHooks({
    hasUnsafeWork: work.running,
    relaunch: () => {
      restarts++
      return true
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
  const work = unsafeWork()
  const release = work.begin()
  const wasEnabled = autoUpdateEnabled()
  const timers = spyOn(globalThis, 'setTimeout')
  let applies = 0
  try {
    setAutoUpdateEnabled(false)
    setAutoUpdateHooks({
      hasUnsafeWork: work.running,
      apply: async () => {
        applies++
        return applied()
      },
      relaunch: () => true,
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

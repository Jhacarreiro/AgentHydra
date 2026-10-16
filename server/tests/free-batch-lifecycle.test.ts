import { expect, test } from 'bun:test'
import { FreeBatchLifecycle } from '../src/free-batch-lifecycle'

test('preflight leases prevent restart before a batch is registered or dispatches work', async () => {
  const lifecycle = new FreeBatchLifecycle()
  let continuePreflight!: () => void
  const preflight = new Promise<void>((resolve) => {
    continuePreflight = resolve
  })
  let dispatched = false
  const release = lifecycle.acquire()
  const batch = (async () => {
    await preflight
    dispatched = true
    release()
  })()
  expect(lifecycle.activeCount()).toBe(1)
  expect(lifecycle.beginRestart()).toBe(false)
  expect(dispatched).toBe(false)
  continuePreflight()
  await batch
  expect(lifecycle.activeCount()).toBe(0)
  expect(lifecycle.beginRestart()).toBe(true)
})

test('a successor handoff refuses new admissions until a failed handoff reopens them', () => {
  const lifecycle = new FreeBatchLifecycle()
  expect(lifecycle.beginRestart()).toBe(true)
  expect(() => lifecycle.acquire()).toThrow('No Free task was started')
  expect(lifecycle.activeCount()).toBe(0)
  lifecycle.abortRestart()
  const release = lifecycle.acquire()
  expect(lifecycle.activeCount()).toBe(1)
  expect(lifecycle.beginRestart()).toBe(false)
  release()
})

test('each lease releases exactly once without dropping another pending batch', () => {
  const lifecycle = new FreeBatchLifecycle()
  const first = lifecycle.acquire()
  const second = lifecycle.acquire()
  first()
  first()
  expect(lifecycle.activeCount()).toBe(1)
  expect(lifecycle.beginRestart()).toBe(false)
  second()
  expect(lifecycle.activeCount()).toBe(0)
  expect(lifecycle.beginRestart()).toBe(true)
})

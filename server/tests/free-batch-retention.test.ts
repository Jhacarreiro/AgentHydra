import { expect, test } from 'bun:test'
import { type BatchRetentionClock, FreeBatchRetention } from '../src/free-batch-retention'

const KEEP = 6 * 60 * 60_000
type Timer = ReturnType<typeof setTimeout>
type FakeTimer = { at: number; run: () => void; unref: () => void }
type Batch = { createdAt: number; settled: boolean; response: string }

function fixture() {
  let wall = 0
  let elapsed = 0
  let armed = 0
  let unrefs = 0
  let cleared = 0
  const timers = new Set<FakeTimer>()
  const clock: BatchRetentionClock = {
    now: () => wall,
    setTimeout: (run, delay) => {
      expect(delay).toBeGreaterThan(0)
      const timer = { at: elapsed + delay, run, unref: () => unrefs++ }
      timers.add(timer)
      armed++
      return timer as unknown as Timer
    },
    clearTimeout: (timer) => {
      expect(timers.delete(timer as unknown as FakeTimer)).toBe(true)
      cleared++
    },
  }
  const batches = new Map<string, Batch>()
  const retention = new FreeBatchRetention(batches, KEEP, clock)
  const add = (id: string, createdAt: number, settled = true) => {
    const batch = { createdAt, settled, response: 'Synthetic retained response' }
    batches.set(id, batch)
    retention.prune()
    return batch
  }
  function advance(ms: number): void {
    const target = elapsed + ms
    let callbacks = 0
    for (;;) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0]
      if (!next || next.at > target) break
      if (++callbacks > 100) throw new Error('Expiry timer is spinning')
      wall += next.at - elapsed
      elapsed = next.at
      timers.delete(next)
      next.run()
    }
    wall += target - elapsed
    elapsed = target
  }
  return {
    batches,
    retention,
    add,
    advance,
    jump: (ms: number) => {
      wall += ms
    },
    stats: () => ({ timers: timers.size, armed, unrefs, cleared }),
    nextDelay: () => [...timers][0]!.at - elapsed,
  }
}

test('completed Free results expire while idle, retaining the exact six-hour boundary and unrefing the only timer', () => {
  const f = fixture()
  const result = f.add('completed', 0)
  expect(f.stats()).toEqual({ timers: 1, armed: 1, unrefs: 1, cleared: 0 })
  expect(f.nextDelay()).toBe(KEEP + 1)
  f.advance(KEEP)
  expect(f.batches.get('completed')).toBe(result)
  expect(result.response).toBe('Synthetic retained response')
  // No new chat or tool read is needed to release the Map's retained result.
  f.advance(1)
  expect(f.batches.size).toBe(0)
  expect(f.stats().timers).toBe(0)
})

test('an active batch remains available past expiry without timer spin and expires only after actual completion', () => {
  const f = fixture()
  const active = f.add('active', 0, false)
  f.add('completed', 0)
  f.advance(KEEP + 1)
  expect(f.batches.get('active')).toBe(active)
  expect(f.batches.has('completed')).toBe(false)
  expect(f.stats()).toEqual({ timers: 0, armed: 1, unrefs: 1, cleared: 0 })
  f.advance(KEEP * 20)
  expect(f.batches.get('active')).toBe(active)
  expect(f.stats().armed).toBe(1)
  active.settled = true
  f.retention.prune()
  expect(f.batches.size).toBe(0)
  expect(f.stats().timers).toBe(0)
})

test('completion before the boundary arms expiry, while pending-only maps have no timer', () => {
  const f = fixture()
  const active = f.add('pending', 0, false)
  expect(f.stats().timers).toBe(0)
  f.advance(1000)
  active.settled = true
  f.retention.prune()
  expect(f.nextDelay()).toBe(KEEP - 999)
  expect(f.stats().unrefs).toBe(1)
  f.advance(KEEP - 1000)
  expect(f.batches.get('pending')).toBe(active)
  f.advance(1)
  expect(f.batches.size).toBe(0)
})

test('multiple batches share the earliest timer, rearm after expiry and cancel it when the map empties', () => {
  const f = fixture()
  f.add('later', 100)
  expect(f.nextDelay()).toBe(KEEP + 101)
  f.add('earlier', 0)
  expect(f.stats()).toEqual({ timers: 1, armed: 2, unrefs: 2, cleared: 1 })
  f.add('pending', 0, false)
  for (let i = 0; i < 20; i++) f.retention.prune()
  expect(f.stats().armed).toBe(2)
  f.advance(KEEP + 1)
  expect([...f.batches.keys()]).toEqual(['later', 'pending'])
  expect(f.nextDelay()).toBe(100)
  expect(f.stats().timers).toBe(1)
  f.advance(100)
  expect([...f.batches.keys()]).toEqual(['pending'])
  expect(f.stats().timers).toBe(0)
  f.add('newer', KEEP + 101)
  expect(f.stats().timers).toBe(1)
  f.batches.clear()
  f.retention.prune()
  expect(f.stats().timers).toBe(0)
  expect(f.stats().cleared).toBe(2)
})

test('clock changes never expire early and a read prunes newly overdue results immediately', () => {
  const backward = fixture()
  const result = backward.add('clock-backward', 0)
  backward.jump(-1000)
  backward.advance(KEEP + 1)
  expect(backward.batches.get('clock-backward')).toBe(result)
  expect(backward.nextDelay()).toBe(1000)
  expect(backward.stats().timers).toBe(1)
  backward.advance(1000)
  expect(backward.batches.size).toBe(0)

  const forward = fixture()
  forward.add('clock-forward', 0)
  forward.jump(KEEP + 1)
  forward.retention.prune()
  expect(forward.batches.size).toBe(0)
  expect(forward.stats()).toEqual({ timers: 0, armed: 1, unrefs: 1, cleared: 1 })
})

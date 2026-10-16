import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = pathToFileURL(resolve(import.meta.dir, '../src/core/intern.ts')).href

/** Observe only invented keys in an isolated process; neither the daemon clock nor its pool changes. */
async function run(body: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { spyOn } from 'bun:test'
    const day = 24 * 3600000
    let now = 1_000_000
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const original = Map.prototype.get
    let reads = []
    const observer = spyOn(Map.prototype, 'get').mockImplementation(function(key) {
      if (typeof key === 'string' && key.startsWith('intern-fixture:')) reads.push(this)
      return Reflect.apply(original, this, [key])
    })
    const assert = (ok, reason) => { if (!ok) throw Error(reason) }
    try {
      const { intern } = await import(${JSON.stringify(source)})
      const call = value => {
        reads = []
        const result = intern(value)
        return { result, current: reads[0], previous: reads[1], gets: reads.length }
      }
      ${body}
    } finally { observer.mockRestore(); clock.mockRestore() }
    process.stdout.write('ok')
  `,
    ],
    { windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exit, stderr).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).toBe('ok')
}

test('existing-key-only traffic rotates at each window and drops obsolete keys', async () => {
  await run(`
    const start = now
    const active = 'intern-fixture:active'
    const first = call(active)
    for (let i = 0; i < 32; i++) call('intern-fixture:stale-' + i)
    assert(first.current.size === 33, 'Initial keys were not pooled')
    now = start + day - 1
    const warm = call(active)
    assert(warm.current === first.current && warm.gets === 1, 'An ordinary hit did not stay in current')
    now = start + day
    const rotated = call(active)
    assert(rotated.current !== first.current && rotated.previous === first.current, 'A hit did not rotate at the boundary')
    assert(rotated.current.size === 1 && rotated.previous.size === 33, 'The first window did not preserve eligible strings')
    const promoted = call('intern-fixture:stale-0')
    assert(promoted.previous === first.current && promoted.result === 'intern-fixture:stale-0', 'Previous-window lookup failed')
    assert(call('intern-fixture:stale-0').gets === 1, 'A promoted key was not a current hit')
    now = start + 2 * day
    const second = call(active)
    assert(second.previous === rotated.current && second.previous.size === 2, 'Expired keys remained in the second window')
    assert(second.current.size === 1, 'An active hit was not renewed')
    const stale = call('intern-fixture:stale-31')
    assert(stale.previous !== first.current && !stale.previous.has('intern-fixture:stale-31'), 'An obsolete table was still consulted')
  `)
}, 20_000)

test('two-window and longer idle gaps discard both tables on hits and misses', async () => {
  await run(`
    const start = now
    const first = call('intern-fixture:first')
    now = start + day
    const middle = call('intern-fixture:middle')
    assert(middle.previous === first.current, 'The ordinary first rotation changed')
    now = start + 3 * day
    const afterTwo = call('intern-fixture:middle')
    assert(afterTwo.current !== middle.current && afterTwo.previous !== middle.current && afterTwo.previous !== first.current, 'An exact two-window gap kept an expired table')
    assert(afterTwo.previous.size === 0 && afterTwo.current.size === 1, 'Idle hit retained stale entries')
    now += 5 * day
    const afterFive = call('intern-fixture:new-after-idle')
    assert(afterFive.previous.size === 0 && afterFive.current.size === 1, 'Idle miss retained stale entries')
  `)
}, 20_000)

test('clock rollback leaves pooling intact and primitive Unicode values unchanged', async () => {
  await run(`
    const start = now
    const values = ['intern-fixture:', 'intern-fixture:café🙂', 'intern-fixture:' + String.fromCharCode(0xd800), 'intern-fixture:' + String.fromCharCode(0xdc00)]
    const first = call(values[0])
    for (const value of values) assert(call(value).result === value, 'Initial string changed')
    now = start - 7 * day
    for (const value of values) {
      const hit = call(value)
      assert(hit.result === value && hit.current === first.current && hit.gets === 1, 'Rollback changed a pooled string')
    }
    const rollbackMiss = call('intern-fixture:during-rollback')
    assert(rollbackMiss.current === first.current, 'Rollback rotated the pool')
    now = start + day - 1
    assert(call(values[1]).current === first.current, 'Catch-up rotated early')
    now = start + day
    const next = call(values[1])
    assert(next.previous === first.current, 'The original boundary was lost after rollback')
    for (const value of values) assert(call(value).result === value, 'Promotion changed UTF-16 code units')
    now += 2 * day
    for (const value of values) assert(call(value).result === value, 'Idle replacement changed primitive text')
  `)
}, 20_000)

// server/tests/extra-usage-scan.test.ts - the guard pays for the full instance listing only when an
// account can bill.
//
// listInstances scans every process (1-1.5 s on a busy host), and the guard used to call it on every
// 30 s pass, ~2,880 scans a day, with nothing to guard. Now each pass first asks the cached readings
// of every store, keyed exactly as the full pass keys them, and lists in full only when one of them
// bills past its limit. What this proves: an idle pass lists nothing; a pass where an account starts
// to bill lists in full and stops the session as before; every login's key is the key the full pass
// reads; and a failing cheap listing falls back to the full pass, so nothing goes unguarded.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { listInstanceLogins, listInstances } from '../src/core/instances'
import { billsPastLimit, guardExtraUsage, setDesktopListingForTests } from '../src/extra-usage'
import { setProviderSettings } from '../src/provider-settings'
import type { UsageSnapshot } from '../src/types'
import { allCachedUsage, dropCachedUsage, setCachedUsage } from '../src/usage'
import { desktopKey } from '../src/usage-service'

const root = process.env.AGENTHYDRA_INSTANCES_ROOT as string
const children: ReturnType<typeof Bun.spawn>[] = []
const written = new Set<string>()
/** Billing readings other tests left in the cache, set aside so an idle pass here is idle. */
const parked = new Map<string, UsageSnapshot>()

beforeEach(() => {
  setProviderSettings({ allowExtraUsage: false })
  for (const [key, snap] of Object.entries(allCachedUsage())) {
    if (!billsPastLimit(snap)) continue
    if (!written.has(key)) parked.set(key, snap)
    dropCachedUsage(key)
  }
})

afterEach(() => {
  setDesktopListingForTests(null)
  for (const key of written) dropCachedUsage(key)
  written.clear()
})

afterAll(() => {
  for (const p of children) p.kill()
  for (const [key, snap] of parked) setCachedUsage(key, snap)
})

/** A reading at 99% of the 5-hour window, on an account that bills past it or stops. */
function reading(extraUsage: boolean): UsageSnapshot {
  return {
    account: 'example',
    session: { pct: 99, resets: '', resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    weekAll: { pct: 40, resets: '', resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    weekModel: null,
    extraUsage,
    capturedAt: new Date().toISOString(),
    source: 'api',
  }
}

function cache(dir: string, extraUsage: boolean): void {
  written.add(desktopKey(dir))
  setCachedUsage(desktopKey(dir), reading(extraUsage))
}

/** A child process standing in for a Code engine. */
function engine(): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  children.push(proc)
  return proc
}

const alive = (p: ReturnType<typeof Bun.spawn>): boolean => p.exitCode === null && !p.killed

interface Row {
  dir: string
  num: number
  name: string
  pid: number | null
}

/** Fake listings over `rows` (logins: `loginDirs`, by default every row), counting each call. */
function fakeListing(
  rows: Row[],
  opts: { loginDirs?: string[]; engines?: { pid: number; instanceDir: string }[] } = {},
) {
  const calls = { instances: 0, logins: 0 }
  setDesktopListingForTests({
    instances: async () => {
      calls.instances++
      return rows
    },
    logins: () => {
      calls.logins++
      return (opts.loginDirs ?? rows.map((r) => r.dir)).map((dir) => ({ dir }))
    },
    engines: async () => opts.engines ?? [],
  })
  return calls
}

const row = (name: string, num: number, pid: number | null = null): Row => ({
  dir: join(root, name),
  num,
  name,
  pid,
})

describe('the extra-usage guard lists in full only when an account can bill', () => {
  test('ten idle passes make no full listing (the old guard made ten)', async () => {
    const a = row('xu-idle-a', 1, 4101)
    const b = row('xu-idle-b', 2)
    cache(a.dir, false) // at its line, but stops there
    const calls = fakeListing([a, b])
    for (let i = 0; i < 10; i++) expect(await guardExtraUsage()).toEqual([])
    expect(calls.instances).toBe(0)
    // Asked afresh on every pass: a verdict of "nothing bills" is never kept.
    expect(calls.logins).toBe(10)
  })

  test('a pass where an account starts to bill lists in full and stops its session', async () => {
    const desk = row('xu-newly-bills', 7, 4102)
    const proc = engine()
    cache(desk.dir, false)
    const calls = fakeListing([desk], { engines: [{ pid: proc.pid, instanceDir: desk.dir }] })

    expect(await guardExtraUsage()).toEqual([])
    expect(calls.instances).toBe(0)
    expect(alive(proc)).toBe(true)

    cache(desk.dir, true)
    expect(await guardExtraUsage()).toEqual([{ store: '#7 xu-newly-bills', pids: [proc.pid] }])
    expect(calls.instances).toBe(1)
    await Promise.race([proc.exited, Bun.sleep(5_000)])
    expect(alive(proc)).toBe(false)
  }, 20_000)

  test("every login's key is the key the full pass reads", async () => {
    const rows = [row('xu-key-a', 11), row('xu-key-b', 12), row('xu-key-c', 13)]
    const calls = fakeListing(rows)
    for (const [i, r] of rows.entries()) {
      cache(r.dir, true)
      await guardExtraUsage()
      expect(calls.instances).toBe(i + 1)
      dropCachedUsage(desktopKey(r.dir))
    }
    await guardExtraUsage()
    expect(calls.instances).toBe(rows.length)

    // A profile outside the instances root is listed only by the process scan: its billing reading
    // still brings the full pass.
    const outside: Row = {
      dir: join(root, '..', 'xu-outside-root'),
      num: 14,
      name: 'xu-outside-root',
      pid: null,
    }
    const withOutside = fakeListing([...rows, outside], { loginDirs: rows.map((r) => r.dir) })
    cache(outside.dir, true)
    await guardExtraUsage()
    expect(withOutside.instances).toBe(1)

    // And the real listings name the same profiles under the root, so the keys agree.
    setDesktopListingForTests(null)
    mkdirSync(join(root, 'xu-real-a'), { recursive: true })
    mkdirSync(join(root, 'xu-real-b'), { recursive: true })
    const cheap = new Set(listInstanceLogins().map((l) => desktopKey(l.dir)))
    const full = new Set(
      (await listInstances()).filter((i) => !i.isExternal).map((i) => desktopKey(i.dir)),
    )
    expect(cheap).toEqual(full)
    expect(cheap.has(desktopKey(join(root, 'xu-real-a')))).toBe(true)
    expect(cheap.has(desktopKey(join(root, 'xu-real-b')))).toBe(true)
    rmSync(join(root, 'xu-real-a'), { recursive: true, force: true })
    rmSync(join(root, 'xu-real-b'), { recursive: true, force: true })
  }, 20_000)

  test('a failing cheap listing falls back to the full pass, and the session is still stopped', async () => {
    const desk = row('xu-cheap-fails', 21, 4103)
    const proc = engine()
    const calls = { instances: 0 }
    setDesktopListingForTests({
      instances: async () => {
        calls.instances++
        return [desk]
      },
      logins: () => {
        throw new Error('instances root unreadable')
      },
      engines: async () => [{ pid: proc.pid, instanceDir: desk.dir }],
    })

    // Even with nothing billing, a listing that failed is no proof of that: the full pass runs.
    expect(await guardExtraUsage()).toEqual([])
    expect(calls.instances).toBe(1)
    expect(alive(proc)).toBe(true)

    cache(desk.dir, true)
    expect(await guardExtraUsage()).toEqual([{ store: '#21 xu-cheap-fails', pids: [proc.pid] }])
    expect(calls.instances).toBe(2)
    await Promise.race([proc.exited, Bun.sleep(5_000)])
    expect(alive(proc)).toBe(false)
  }, 20_000)
})

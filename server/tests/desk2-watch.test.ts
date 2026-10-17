// The daemon starts Desk 2's server again only when it died without a stop (server/src/desk2-watch.ts): its pid
// file is still there, the processes it names are gone, and health has been silent for DOWN_FOR_MS. A deliberate stop
// (stop.ps1 removes the pid file), a busy or booting server (its process runs), another checkout's server, one left
// from before a reboot and a crash loop are all left alone. Every effect is faked; nothing here starts a process.
import { describe, expect, test } from 'bun:test'
import {
  createDesk2Watch,
  type Desk2WatchDeps,
  DOWN_FOR_MS,
  MAX_REVIVES,
  parsePidFile,
  recordedAlive,
  WATCH_INTERVAL_MS,
} from '../src/desk2-watch'

const DESK = 'C:/Users/me/AgentHydra/desk2'
const BOOT = Date.parse('2026-10-17T08:00:00Z')
const T0 = Date.parse('2026-10-17T15:00:00Z')

function pidText(over: Record<string, unknown> = {}): string {
  return `\uFEFF${JSON.stringify({
    wrapperPid: 55040,
    wrapperStarted: '2026-10-17T14:13:24.9914237Z',
    serverPid: 48604,
    serverStarted: '2026-10-17T14:13:26.1360053Z',
    port: 7798,
    deskRoot: 'C:\\Users\\me\\AgentHydra\\desk2',
    startedAt: '2026-10-17T14:13:25.0929468Z',
    ...over,
  })}`
}

interface Rig {
  watch: ReturnType<typeof createDesk2Watch>
  world: { healthy: boolean; pid: string | null; alive: boolean; installing: boolean; now: number }
  starts: number
  lines: string[]
  /** Ticks until `ms` have passed, one WATCH_INTERVAL_MS apart, and returns each verdict. */
  run: (ms: number) => Promise<(string | null)[]>
}

function rig(over: Partial<Desk2WatchDeps> = {}): Rig {
  const world = {
    healthy: false,
    pid: pidText() as string | null,
    alive: false,
    installing: false,
    now: T0,
  }
  const r: Rig = {
    world,
    starts: 0,
    lines: [],
    watch: undefined as unknown as ReturnType<typeof createDesk2Watch>,
    run: async (ms) => {
      const out: (string | null)[] = []
      const until = world.now + ms
      for (;;) {
        out.push(await r.watch.tick())
        if (world.now + WATCH_INTERVAL_MS > until) return out
        world.now += WATCH_INTERVAL_MS
      }
    },
  }
  r.watch = createDesk2Watch({
    healthy: async () => world.healthy,
    installing: () => world.installing,
    present: () => true,
    deskDir: () => DESK,
    home: () => 'C:/Users/me/.hydra-desk-2',
    readPidFile: () => world.pid,
    alive: async () => world.alive,
    start: async () => {
      r.starts++
      return { ok: true, started: true }
    },
    bootAtMs: () => BOOT,
    now: () => world.now,
    log: (l) => r.lines.push(l),
    warn: (l) => r.lines.push(l),
    ...over,
  })
  return r
}

describe('desk2 watch', () => {
  test('a server that died without a stop is started again once it has been down DOWN_FOR_MS', async () => {
    const r = rig()
    const verdicts = await r.run(DOWN_FOR_MS - 1)
    expect(verdicts.every((v) => v === 'down')).toBe(true)
    expect(r.starts).toBe(0)
    r.world.now += WATCH_INTERVAL_MS
    expect(await r.watch.tick()).toBe('revive')
    expect(r.starts).toBe(1)
    // One "down" line as the outage begins, not one per tick.
    expect(r.lines.filter((l) => l.includes('not answering')).length).toBe(1)
  })

  test('a deliberate stop (no pid file), a live process and a healthy server are never started', async () => {
    for (const set of [
      (w: Rig['world']) => {
        w.pid = null
      },
      (w: Rig['world']) => {
        w.alive = true
      },
      (w: Rig['world']) => {
        w.healthy = true
      },
      (w: Rig['world']) => {
        w.installing = true
      },
    ]) {
      const r = rig()
      set(r.world)
      await r.run(DOWN_FOR_MS * 4)
      expect(r.starts).toBe(0)
    }
  })

  test("another checkout's server and one started before this boot are left alone", async () => {
    const other = rig()
    other.world.pid = pidText({ deskRoot: 'C:\\Users\\me\\other\\desk2' })
    await other.run(DOWN_FOR_MS * 4)
    expect(other.starts).toBe(0)

    const beforeBoot = rig()
    beforeBoot.world.pid = pidText({ startedAt: '2026-10-17T07:00:00Z' })
    await beforeBoot.run(DOWN_FOR_MS * 4)
    expect(beforeBoot.starts).toBe(0)
  })

  test('a new pid file (a start under way) restarts the wait', async () => {
    const r = rig()
    await r.run(DOWN_FOR_MS - WATCH_INTERVAL_MS)
    r.world.pid = pidText({ wrapperPid: 777, startedAt: '2026-10-17T14:59:00Z' })
    r.world.now += WATCH_INTERVAL_MS
    expect(await r.watch.tick()).toBe('down')
    await r.run(DOWN_FOR_MS - WATCH_INTERVAL_MS)
    expect(r.starts).toBe(0)
  })

  test('a server that will not stay up is started MAX_REVIVES times, then left with one line', async () => {
    const r = rig()
    await r.run(DOWN_FOR_MS * (MAX_REVIVES + 3))
    expect(r.starts).toBe(MAX_REVIVES)
    expect(r.lines.filter((l) => l.includes('did not keep it up')).length).toBe(1)
  })
})

describe('server.pid and the processes it names', () => {
  test('parsePidFile reads what start.ps1 writes, BOM included', () => {
    const p = parsePidFile(pidText())
    expect(p?.deskRoot).toBe('C:\\Users\\me\\AgentHydra\\desk2')
    expect(p?.processes.map((x) => x.pid)).toEqual([48604, 55040])
    expect(p?.startedAtMs).toBe(Date.parse('2026-10-17T14:13:25.0929468Z'))
    expect(parsePidFile('not json')).toBeNull()
    // serverPid is 0 until start.ps1 has found bun's own pid.
    expect(parsePidFile(pidText({ serverPid: 0, serverStarted: '' }))?.processes.length).toBe(1)
  })

  test('a recycled pid (running, another start time) is not the server; a pid that cannot be read counts as alive', async () => {
    const procs = [{ pid: 48604, started: '2026-10-17T14:13:26.1360053Z' }]
    expect(await recordedAlive(procs, { exists: () => false })).toBe(false)
    expect(
      await recordedAlive(procs, {
        exists: () => true,
        startTimes: async () => new Map([[48604, '2026-10-17T15:40:00.0000000Z']]),
      }),
    ).toBe(false)
    expect(
      await recordedAlive(procs, {
        exists: () => true,
        startTimes: async () => new Map([[48604, '2026-10-17T14:13:26.1360053Z']]),
      }),
    ).toBe(true)
    expect(await recordedAlive(procs, { exists: () => true, startTimes: async () => null })).toBe(
      true,
    )
  })
})

// server/tests/port-owner.test.ts — reading the OS connection table (server/src/core/process.ts).
//
// This is how the daemon answers "who just called me?" for MCP over HTTP: the caller's peer port,
// looked up in the connection table, names the process that opened the socket - which is the
// Claude Code engine, under its own instance directory. A parser over another program's text is
// exactly the code that rots without anyone noticing, so it is pinned here against REAL
// `netstat -ano` output (Windows 11, 2026-09-11), including the lines around it.

import { describe, expect, spyOn, test } from 'bun:test'
import { netstatOwnerPid, pidOwningLocalPort } from '../src/core/process'

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104',
  '  TCP    127.0.0.1:7787         0.0.0.0:0              LISTENING       23152',
  '  TCP    127.0.0.1:54321        127.0.0.1:7787         ESTABLISHED     66800',
  '  TCP    127.0.0.1:7787         127.0.0.1:54321        ESTABLISHED     23152',
  '  TCP    127.0.0.1:54399        127.0.0.1:7787         TIME_WAIT       0',
  '  TCP    [::1]:2869             [::]:0                 LISTENING       4',
  '  UDP    0.0.0.0:5353           *:*                                    3112',
].join('\r\n')

describe('netstatOwnerPid', () => {
  test('names the process that opened the connection, not the one that accepted it', () => {
    // 54321 is the CALLER's own local port; 7787 is ours. The row we want is the caller's.
    expect(netstatOwnerPid(NETSTAT, 54321)).toBe(66800)
  })

  test('a port with no established row is null, never a guess', () => {
    expect(netstatOwnerPid(NETSTAT, 54399)).toBeNull() // TIME_WAIT: not a live caller
    expect(netstatOwnerPid(NETSTAT, 9999)).toBeNull()
    expect(netstatOwnerPid('', 54321)).toBeNull()
  })

  test('a LISTENING socket on the same port number is not an answer', () => {
    // 7787 appears as our own listener AND as the far end of the caller's row. Neither makes
    // the daemon the caller, and answering 23152 here would identify every agent as the tray.
    expect(netstatOwnerPid(NETSTAT, 7787)).toBe(23152)
    const listenerOnly = [
      '  TCP    127.0.0.1:7787         0.0.0.0:0              LISTENING       23152',
    ].join('\r\n')
    expect(netstatOwnerPid(listenerOnly, 7787)).toBeNull()
  })

  test('two processes claiming one local port answers null rather than picking one', () => {
    const ambiguous = [
      '  TCP    127.0.0.1:54321        127.0.0.1:7787         ESTABLISHED     66800',
      '  TCP    10.0.0.5:54321         10.0.0.9:443           ESTABLISHED     4242',
    ].join('\r\n')
    expect(netstatOwnerPid(ambiguous, 54321)).toBeNull()
  })

  test('UDP rows and garbage are ignored', () => {
    expect(netstatOwnerPid(NETSTAT, 5353)).toBeNull()
    expect(netstatOwnerPid('not a table at all', 54321)).toBeNull()
  })
})

// One netstat per lookup put 346 netstat.exe under the daemon at once (2026-10-11). Lookups now share
// a table read, but only one that began after they asked: a recycled port must never be answered from
// an older table, which is the identity bug the no-cache rule exists for.
describe.skipIf(process.platform !== 'win32')('pidOwningLocalPort under concurrent callers', () => {
  test('callers waiting on a running read share the next one, and only the next one', async () => {
    const releases: Array<() => void> = []
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      expect(cmd[0]).toBe('netstat')
      const n = releases.length + 1 // which read this is; its table names pid 1000 + n as the caller
      let release!: () => void
      const done = new Promise<void>((r) => (release = r))
      releases.push(release)
      const row = `  TCP    127.0.0.1:50001        127.0.0.1:7787         ESTABLISHED     ${1000 + n}\r\n`
      const proc = {
        pid: undefined,
        killed: false,
        exitCode: null as number | null,
        stdout: new ReadableStream<Uint8Array>({
          async start(c) {
            await done
            c.enqueue(new TextEncoder().encode(row))
            c.close()
          },
        }),
        stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        exited: done.then((): number => {
          proc.exitCode = 0
          return 0
        }),
      }
      return proc
    }) as unknown as typeof Bun.spawn)
    const settle = async (reads: number) => {
      for (let i = 0; i < 200 && releases.length < reads; i++) await Bun.sleep(1)
    }
    try {
      const first = pidOwningLocalPort(50001)
      await settle(1)
      const second = pidOwningLocalPort(50001)
      const third = pidOwningLocalPort(50001)
      await Bun.sleep(5)
      expect(spawn).toHaveBeenCalledTimes(1) // the two late callers wait; they do not each spawn

      releases[0]!()
      expect(await first).toBe(1001)
      await settle(2)
      releases[1]!()
      // Answered by the read that started after they asked, never by the one already running.
      expect(await second).toBe(1002)
      expect(await third).toBe(1002)
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally {
      for (const r of releases) r()
      spawn.mockRestore()
    }
  })
})

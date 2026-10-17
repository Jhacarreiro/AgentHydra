// start.ps1 forwards HYDRA_DESK_PUBLIC_ORIGINS to the WMI-started server on its command line (the server reads it
// from there, since a WMI start gets the user's environment, not this script's). A value outside an origin list's
// characters is refused and named, never put on a cmd line: & % or a quote would be read by cmd. The dry run prints
// what it would forward, so this checks the forwarding with no server started.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const LAUNCHER = resolve(import.meta.dir, '../../launcher')
const SHELLS = ['powershell', 'pwsh'].filter((s) => Bun.which(s))
const WOULD_START = 'would start hidden through WMI'

async function dryRun(shell: string, publicOrigins: string | undefined, home: string): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, HYDRA_DESK_HOME: home, HYDRA_DESK_PORT: '1' }
  if (publicOrigins === undefined) delete env.HYDRA_DESK_PUBLIC_ORIGINS
  else env.HYDRA_DESK_PUBLIC_ORIGINS = publicOrigins
  // Port 1: nothing listens there, so start.ps1 takes the would-start branch.
  const proc = Bun.spawn([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(LAUNCHER, 'start.ps1'), '-DryRun', '-NoWindow'], {
    env: env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

describe.skipIf(process.platform !== 'win32' || SHELLS.length === 0)('start.ps1 forwards HYDRA_DESK_PUBLIC_ORIGINS', () => {
  test('a plain origin list is forwarded on the WMI command line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-launcher-origins-'))
    try {
      for (const shell of SHELLS) {
        const out = await dryRun(shell, 'https://desk.example.test', home)
        const line = out.split('\n').find((l) => l.includes(WOULD_START)) ?? ''
        expect(line).toContain('HYDRA_DESK_PUBLIC_ORIGINS=https://desk.example.test')
        expect(out).not.toContain('refused')
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)

  test('a value with cmd characters is refused and named, and never reaches the command line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-launcher-origins-'))
    try {
      for (const shell of SHELLS) {
        const out = await dryRun(shell, 'https://desk.example.test/?a=1&b=%PATH%"x', home)
        const line = out.split('\n').find((l) => l.includes(WOULD_START)) ?? ''
        expect(line).not.toContain('HYDRA_DESK_PUBLIC_ORIGINS=')
        // The refusal is said on its own line, not left inside the forwarded-variable list of the would-start line.
        expect(line).not.toContain('refused')
        const refusal = out.split('\n').find((l) => l.includes('HYDRA_DESK_PUBLIC_ORIGINS refused')) ?? ''
        expect(refusal).not.toBe('')
        expect(refusal).not.toContain(WOULD_START)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)

  test('unset, nothing is forwarded and nothing is said', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-launcher-origins-'))
    try {
      for (const shell of SHELLS) {
        const out = await dryRun(shell, undefined, home)
        expect(out).not.toContain('HYDRA_DESK_PUBLIC_ORIGINS')
        expect(out).toContain(WOULD_START)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})

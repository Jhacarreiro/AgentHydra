// Desk's server runs under its own name, AgentHydra-desk.exe (launcher/start.ps1, Use-OwnName): a copy of the bun
// found, so a chat's `taskkill /IM bun.exe` passes it by. The copy must be made once, kept while bun is unchanged,
// made again when bun changes, and carry a stamp naming the real bun that the server can read back (JSON without the
// BOM Windows PowerShell's -Encoding UTF8 would add). Runs the function itself, cut out of start.ps1, in both shells.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const START = resolve(import.meta.dir, '../../launcher/start.ps1')
const SHELLS = ['powershell', 'pwsh'].filter((s) => Bun.which(s))

// Parse start.ps1, define only Use-OwnName (with a Say that prints), and run it on a stand-in bun.
const HARNESS = `
param([string]$Script, [string]$DeskHome, [string]$Bun)
$ErrorActionPreference = 'Stop'
$DryRun = $false
function Say([string]$msg) { Write-Host "say: $msg" }
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Use-OwnName' }, $true)
. ([ScriptBlock]::Create($fn.Extent.Text))
$r = Use-OwnName @{ Source = $Bun; Extension = '.exe' }
Write-Output "source=$($r.Source)"
`

let work = ''
let harness = ''

async function useOwnName(shell: string, home: string, bun: string): Promise<{ source: string; said: string }> {
  const proc = Bun.spawn(
    [shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness, '-Script', START, '-DeskHome', home, '-Bun', bun],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const source = out.match(/^source=(.*)$/m)?.[1]?.trim() ?? ''
  if (!source) throw new Error(`no result: ${out} ${err}`)
  return { source, said: out }
}

describe.skipIf(process.platform !== 'win32' || SHELLS.length === 0)("Desk's server's own name", () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'desk-own-name-'))
    harness = join(work, 'harness.ps1')
    writeFileSync(harness, HARNESS)
  })
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  for (const shell of SHELLS) {
    test(`${shell}: makes the copy once, keeps it, and makes it again when bun changes`, async () => {
      const home = mkdtempSync(join(work, `${shell}-home-`))
      const bun = join(work, `${shell}-bun.exe`)
      writeFileSync(bun, 'stand-in bun v1')
      const exe = join(home, 'bin', 'AgentHydra-desk.exe')

      const first = await useOwnName(shell, home, bun)
      expect(first.source).toBe(exe)
      expect(first.said).toContain('say: made')
      expect(readFileSync(exe, 'utf8')).toBe('stand-in bun v1')
      const raw = readFileSync(`${exe}.source.json`, 'utf8')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      const stamp = JSON.parse(raw) as { source: string; size: number; mtimeMs: number }
      expect(stamp.source.toLowerCase()).toBe(bun.toLowerCase())
      expect(stamp.size).toBe('stand-in bun v1'.length)

      const again = await useOwnName(shell, home, bun)
      expect(again.source).toBe(exe)
      expect(again.said).not.toContain('say: made')

      writeFileSync(bun, 'stand-in bun v2, longer')
      utimesSync(bun, new Date(), new Date(Date.now() + 5000))
      const changed = await useOwnName(shell, home, bun)
      expect(changed.said).toContain('say: made')
      expect(readFileSync(exe, 'utf8')).toBe('stand-in bun v2, longer')
    }, 60_000)
  }

  test('a bun that is not an .exe (an npm .cmd shim) keeps its own name', async () => {
    const home = mkdtempSync(join(work, 'cmd-home-'))
    const shim = join(work, 'bun.cmd')
    writeFileSync(shim, '@echo off')
    const r = await useOwnName(SHELLS[0] as string, home, shim)
    expect(r.source).toBe(shim)
  }, 30_000)
})

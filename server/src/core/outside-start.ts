/**
 * Start a long-lived program OUTSIDE this daemon's process tree and every job it is in (Windows), so
 * it keeps running when the daemon exits: the always-on helpers (helpers.ts).
 *
 * ⛔ WHY. Every child Bun.spawn starts on Windows goes into Bun's own job object (libuv's, made with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, its only handle held by this process), so the child ends the
 * moment the daemon exits, and a self-update relaunch exits the daemon. Measured 2026-10-16: seven
 * relaunches in one day each ended the MCP host the daemon had started, every call in flight on it
 * with them (three of those runs were about 20 minutes long), and the next daemon started a new one
 * about 3 s later. A process WMI's Win32_Process.Create starts belongs to the WMI service: it has no
 * parent here and is in no job (measured the same day: such a process survived the same relaunches).
 *
 * detached-spawn.mjs makes the same hand-off for a window or a successor daemon, but it cannot pass
 * an environment or a folder, or say the pid. This one does all three:
 *   · The environment: Win32_ProcessStartup.EnvironmentVariables REPLACES the new process's
 *     environment (a create given two variables saw exactly two), so the whole block is passed, one
 *     entry per name regardless of case: Windows names are case-blind, and Windows PowerShell's
 *     ConvertFrom-Json refuses two keys that differ only in case.
 *   · The request rides stdin as base64 UTF-8 JSON, so no value reaches a command line or the console
 *     code page.
 *   · Output: WMI cannot give a process file handles, so the program runs under
 *     `cmd.exe /c ... >>log 2>&1`, which stays as its parent and ends when it does. cmd reads `%NAME%`
 *     even inside quotes, and a `"` would end a quoted argument, so an argument holding either is
 *     refused rather than passed changed.
 *   · No window, ever: CREATE_NO_WINDOW gives cmd a console that has no window, and the program and
 *     everything it starts share it, as they did under Bun's windowsHide. DETACHED_PROCESS would
 *     leave cmd with no console at all, and a console program started from there gets a new, visible
 *     one. CREATE_NEW_PROCESS_GROUP keeps other consoles' Ctrl+C away; ShowWindow 0 as well.
 */

import { join } from 'node:path'
import { spawnCaptured } from './process'

const CREATE_NO_WINDOW = 0x0800_0000
const CREATE_NEW_PROCESS_GROUP = 0x200
/** The transient PowerShell plus the WMI call take 0.4-3 s; this is for a PC with its CPU pinned. */
const START_TIMEOUT_MS = 30_000

const WMI_START = `$ErrorActionPreference = 'Stop'
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
$vars = [string[]]@($req.env.PSObject.Properties | ForEach-Object { $_.Name + '=' + $_.Value })
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]${CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP}; EnvironmentVariables = $vars }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $req.commandLine; CurrentDirectory = $req.cwd; ProcessStartupInformation = $si }
if ($r.ReturnValue -ne 0) { [Console]::Error.Write('Win32_Process.Create returned ' + $r.ReturnValue); exit 1 }
[Console]::Out.Write([string]$r.ProcessId)`

function systemFile(...parts: string[]): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts)
}

/** One argument as a quoted command-line token cmd.exe passes on unchanged. Throws on one it would
 *  change. Inside quotes only a run of backslashes before the closing quote means anything to the
 *  program's own parser (CommandLineToArgvW); doubled, it stays literal. */
function cmdToken(arg: string): string {
  if (/["%\r\n]/.test(arg))
    throw new Error(
      `cmd.exe would change the argument ${JSON.stringify(arg)}: one holding " or % cannot be started on Windows`,
    )
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`
}

/** `argv` as cmd.exe runs it with stdout and stderr appended to `logFile`. */
export function loggedCommandLine(argv: string[], logFile: string): string {
  const program = argv.map(cmdToken).join(' ')
  return `${cmdToken(systemFile('cmd.exe'))} /d /v:off /s /c "${program} >>${cmdToken(logFile)} 2>&1"`
}

/** Starts `argv` hidden and outside this process's tree, in `cwd`, with exactly `env`, its output
 *  appended to `logFile`. Resolves the pid of the cmd.exe it runs under (its parent while it runs).
 *  Throws when it could not be started. */
export async function startOutsideDaemon(
  argv: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; logFile: string; lane?: string },
): Promise<number> {
  const env = new Map<string, [string, string]>()
  // "=C:" and the like are cmd's per-drive folders, not variables.
  for (const [name, value] of Object.entries(opts.env))
    if (value !== undefined && name && !name.startsWith('='))
      env.set(name.toUpperCase(), [name, value])
  const request = {
    commandLine: loggedCommandLine(argv, opts.logFile),
    cwd: opts.cwd,
    env: Object.fromEntries(env.values()),
  }
  const run = await spawnCaptured(
    [
      systemFile('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(WMI_START, 'utf16le').toString('base64'),
    ],
    {
      stdin: Buffer.from(JSON.stringify(request), 'utf8').toString('base64'),
      timeoutMs: START_TIMEOUT_MS,
      lane: opts.lane,
    },
  )
  const pid = Number(run.stdout.trim())
  if (run.code === 0 && Number.isInteger(pid) && pid > 0) return pid
  throw new Error(
    run.timedOut
      ? `the WMI start did not answer within ${START_TIMEOUT_MS / 1000} s`
      : `the WMI start failed: ${(run.stderr || run.stdout || `exit ${run.code}`).trim().slice(0, 300)}`,
  )
}

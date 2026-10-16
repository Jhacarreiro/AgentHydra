// fork-e2e/harness.ts - the black-box lane's shared code: a temp home per scenario, the daemon as a
// child process on a free port, JSON over HTTP, a counting egress proxy, and the check that the real
// HOME was left alone. It imports nothing from server/src or desk2: everything here goes through
// processes, files and sockets, so the lane sees what a person or a client sees.
//
// Isolation follows scripts/smoke-release.ts (HOME, USERPROFILE, LOCALAPPDATA, APPDATA,
// AGENTHYDRA_HOME, HYDRA_DESK_HOME, CLAUDE_CONFIG_DIR, both download bases refusing) plus the roots
// tests/setup.ts redirects for the root suite. The child env is built from scratch rather than
// copied from this process, so nothing of the developer's shell (a CLAUDE_CONFIG_DIR, a proxy, a
// CliMayte worker id) reaches the daemon.
import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Subprocess } from 'bun'

/** The checkout under test: this folder's parent. */
export const REPO = resolve(import.meta.dir, '..')
/** FORK_E2E_KEEP=1 keeps every temp home (logs included) after the run, for CI to show on failure. */
const KEEP = process.env.FORK_E2E_KEEP === '1'
/** How long a daemon gets to answer /api/health. A cold boot takes 0.3-1 s here; CI is slower. */
const BOOT_MS = 45_000

export function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

// --- egress -------------------------------------------------------------------------------------

/** A loopback listener that records the first request line of every connection made to it and
 *  refuses it. Pointed at as HTTPS_PROXY it sees every outbound call a proxy-aware client makes
 *  (`CONNECT host:443`); pointed at as a download base it sees the request itself. */
export interface Counter {
  url: string
  /** One entry per connection: its first request line (method and target), or '' if it sent none. */
  hits: string[]
  stop(): void
}

export function counter(): Counter {
  const hits: string[] = []
  const server = Bun.listen<{ at: number }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(s) {
        s.data = { at: hits.push('') - 1 }
      },
      data(s, chunk) {
        if (!hits[s.data.at]) {
          const line = chunk.toString('latin1').split('\r\n')[0] ?? ''
          hits[s.data.at] = line.split(' ').slice(0, 2).join(' ')
        }
        s.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      },
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) }
}

/** The host a recorded hit was for: `CONNECT host:443` and `GET http://host/...` both name one. */
export function hitHost(hit: string): string {
  const target = hit.split(' ')[1] ?? ''
  try {
    return new URL(target.includes('://') ? target : `https://${target}`).hostname
  } catch {
    return target
  }
}

// --- temp homes ---------------------------------------------------------------------------------

export interface Home {
  dir: string
  env: Record<string, string>
  /** HTTPS_PROXY and HTTP_PROXY: every proxy-aware outbound call lands here and is refused. */
  egress: Counter
  /** AGENTHYDRA_RELEASE_BASE and AGENTHYDRA_BUN_BASE: nothing may be downloaded. */
  downloads: Counter
  /** Kill every process still running with this home in its env, then remove the folder. */
  dispose(): void
}

const homes: Home[] = []

/** A temp home with every state root the daemon, Desk 2 and their children read pointed inside it,
 *  `claude` on PATH (and AGENTHYDRA_CLAUDE_PATH) answering as server/tests/mocks/fake-claude.ts, and
 *  outbound traffic sent to counters that refuse it. */
export function makeHome(name: string): Home {
  const base = process.env.FORK_E2E_TMP || tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `fork-e2e-${name.toLowerCase()}-`))
  for (const d of [
    'AppData/Local',
    'AppData/Roaming',
    '.claude/projects',
    'tmp',
    'bin',
    'work',
    'logs',
  ])
    mkdirSync(join(dir, d), { recursive: true })
  // The daemon runs `claude` by AGENTHYDRA_CLAUDE_PATH; anything that looks it up on PATH finds the
  // same fake first, never a real CLI with a real login.
  const fake = join(dir, 'bin', 'claude')
  writeFileSync(
    fake,
    `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, 'server/tests/mocks/fake-claude.ts')}" "$@"\n`,
  )
  chmodSync(fake, 0o755)
  const egress = counter()
  const downloads = counter()
  const ah = join(dir, 'agenthydra')
  const env: Record<string, string> = {
    PATH: [join(dir, 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(':'),
    LANG: 'C.UTF-8',
    // Marks every process of this home, the daemon's children included, for dispose() to find.
    FORK_E2E_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
    LOCALAPPDATA: join(dir, 'AppData/Local'),
    APPDATA: join(dir, 'AppData/Roaming'),
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_CACHE_HOME: join(dir, '.cache'),
    XDG_DATA_HOME: join(dir, '.local/share'),
    XDG_STATE_HOME: join(dir, '.local/state'),
    TMPDIR: join(dir, 'tmp'),
    TEMP: join(dir, 'tmp'),
    TMP: join(dir, 'tmp'),
    AGENTHYDRA_HOME: ah,
    AGENTHYDRA_DATA_DIR: join(ah, 'data'),
    AGENTHYDRA_DB: join(ah, 'data/agenthydra.db'),
    AGENTHYDRA_CORE_DIR: join(ah, 'core'),
    AGENTHYDRA_INSTANCES_ROOT: join(dir, '.claude-instances'),
    AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(dir, '.claude/projects'),
    AGENTHYDRA_CODEX_HOME: join(dir, '.codex'),
    CODEX_HOME: join(dir, '.codex'),
    CLAUDE_CONFIG_DIR: join(dir, '.claude'),
    AGENTHYDRA_MCP_CONFIG: join(dir, '.claude.json'),
    AGENTHYDRA_CLAUDE_PATH: fake,
    HYDRA_FAMILY_DIR: join(dir, 'hydra-family'),
    // The HSwarm sidecar (server/src/hswarm.ts) is a Python server whose packages the lane does not
    // install: it would run on a machine that has them and crash at import elsewhere, so the lane
    // would differ by machine. Off, with its home and port still pointed here in case it starts.
    AGENTHYDRA_HSWARM_ENABLED: '0',
    HSWARM_HOME: join(dir, '.hswarm'),
    HSWARM_PORT: String(freePort()),
    HYDRA_DESK_HOME: join(dir, 'desk2'),
    HYDRA_DESK_PORT: String(freePort()),
    ORCHESTRATOR_STATE_DIR: join(dir, 'orchestrator-state'),
    ORCH_NO_TUNNEL: '1',
    AGENTHYDRA_NO_OPEN: '1',
    AGENTHYDRA_NO_PING: '1',
    AGENTHYDRA_HEADLESS: '1',
    AGENTHYDRA_CLAUDE_GUARD: '0',
    AGENTHYDRA_RELEASE_BASE: downloads.url,
    AGENTHYDRA_BUN_BASE: downloads.url,
    HTTPS_PROXY: egress.url,
    HTTP_PROXY: egress.url,
    ALL_PROXY: egress.url,
    https_proxy: egress.url,
    http_proxy: egress.url,
    all_proxy: egress.url,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
  const home: Home = {
    dir,
    env,
    egress,
    downloads,
    dispose() {
      killProcessesOf(dir)
      egress.stop()
      downloads.stop()
      if (!KEEP) rmSync(dir, { recursive: true, force: true })
    },
  }
  homes.push(home)
  return home
}

/** SIGKILL every process whose environment carries this home's FORK_E2E_HOME (Linux: /proc). A
 *  SIGKILLed daemon leaves its children behind (the HSwarm sidecar, a CliMayte worker's CLI), and
 *  this finds them wherever they were reparented. Elsewhere only the processes the lane spawned
 *  itself are ended (see `spawned`). */
function killProcessesOf(dir: string): void {
  if (process.platform !== 'linux') return
  const mark = `FORK_E2E_HOME=${dir}\0`
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'latin1').includes(mark))
        process.kill(Number(pid), 'SIGKILL')
    } catch {
      // gone already, or not ours to read
    }
  }
}

// --- processes ----------------------------------------------------------------------------------

const spawned = new Set<Subprocess>()
process.on('exit', () => {
  for (const p of spawned) p.kill('SIGKILL')
  for (const h of homes) killProcessesOf(h.dir)
})
// A run stopped from outside (Ctrl-C, a cancelled job, a kill) still ends what it started, through
// the exit hook above: a daemon left running would keep serving from a home nobody removes.
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

/** Hand `log`, opened for append, to the child `spawn` starts, and track the child for the exit hook. */
function spawnLogged<P extends Subprocess>(log: string, spawn: (fd: number) => P): P {
  const fd = openSync(log, 'a')
  try {
    const proc = spawn(fd)
    spawned.add(proc)
    void proc.exited.then(() => spawned.delete(proc))
    return proc
  } finally {
    closeSync(fd)
  }
}

/** Start a child with its output appended to `log`; the lane SIGKILLs it at exit if nothing else did. */
export function start(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; log: string },
): Subprocess {
  return spawnLogged(opts.log, (fd) =>
    Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: 'ignore', stdout: fd, stderr: fd }),
  )
}

/** Like start(), with stdin and stdout left as pipes for the caller to speak a protocol over. */
export function startPiped(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; log: string },
): Subprocess<'pipe', 'pipe', number> {
  return spawnLogged(opts.log, (fd) =>
    Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: 'pipe', stdout: 'pipe', stderr: fd }),
  )
}

/** Resolves with the exit code, or null if it has not exited within `ms`. */
export async function exitWithin(proc: Subprocess, ms: number): Promise<number | null> {
  const timer = Bun.sleep(ms).then(() => null)
  return Promise.race([proc.exited, timer])
}

export function tail(file: string, lines = 40): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

export interface Answer {
  status: number
  /** Parsed JSON, else the text: whatever the server sent. */
  body: any
  headers: Headers
}

/** One request; a JSON body is parsed, anything else comes back as text. Never throws on status. */
export async function call(url: string, init: RequestInit = {}): Promise<Answer> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json')
  const res = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body, headers: res.headers }
}

export async function waitFor(
  what: string,
  check: () => Promise<boolean> | boolean,
  ms: number,
  every = 100,
): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      if (await check()) return
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await Bun.sleep(every)
  }
}

// --- the daemon ---------------------------------------------------------------------------------

export interface Daemon {
  proc: Subprocess
  port: number
  url: string
  log: string
  /** What GET /api/update/settings said before the harness turned auto-update off. */
  autoUpdateAtBoot: boolean
  api(path: string, init?: RequestInit): Promise<Answer>
  /** Send `signal` and wait for the exit; SIGKILL after `ms`. Resolves with the exit code. */
  stop(signal?: NodeJS.Signals, ms?: number): Promise<number | null>
}

/**
 * `bun server/src/main.ts` (the one entrypoint, server/src/main.ts) in `home` on `port`, awaited
 * until /api/health answers as AgentHydra from this home's store. Auto-update is then switched off
 * (POST /api/update/settings, persisted in the store): it is ON by default (server/src/db.ts
 * DEFAULT_SETTINGS auto_update_enabled) and applies itself with `git pull` and a reinstall on the
 * checkout the daemon runs from, which here is the checkout under test. Its first tick is one
 * interval (6 h) out, so nothing it could do happens between the health answer and the switch.
 */
export async function bootDaemon(
  home: Home,
  opts: { port?: number; env?: Record<string, string> } = {},
): Promise<Daemon> {
  const port = opts.port ?? freePort()
  const url = `http://127.0.0.1:${port}`
  const boots = readdirSync(join(home.dir, 'logs')).filter((f) => f.startsWith('daemon-')).length
  const log = join(home.dir, 'logs', `daemon-${boots + 1}.log`)
  const proc = start([process.execPath, 'server/src/main.ts'], {
    cwd: REPO,
    env: { ...home.env, PORT: String(port), ...opts.env },
    log,
  })
  const api = (path: string, init?: RequestInit) => call(url + path, init)
  try {
    await waitFor(
      `the daemon on ${url}`,
      async () => {
        if (proc.exitCode !== null) throw new Error(`the daemon exited with ${proc.exitCode}`)
        const h = await api('/api/health')
        return h.status === 200 && h.body?.service === 'agenthydra'
      },
      BOOT_MS,
    )
  } catch (e) {
    proc.kill('SIGKILL')
    throw new Error(`${e instanceof Error ? e.message : e}\n--- ${log}\n${tail(log)}`)
  }
  const health = (await api('/api/health')).body
  // A daemon answering from any other store would be a daemon this lane must not touch.
  if (!String(health.dbPath).startsWith(home.dir + sep))
    throw new Error(`the daemon on ${url} uses ${health.dbPath}, outside ${home.dir}`)
  const before = await api('/api/update/settings')
  const off = await api('/api/update/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  })
  if (off.body?.enabled !== false) throw new Error(`auto-update did not turn off: ${off.status}`)
  return {
    proc,
    port,
    url,
    log,
    autoUpdateAtBoot: before.body?.enabled === true,
    api,
    async stop(signal = 'SIGTERM', ms = 15_000) {
      if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode
      proc.kill(signal)
      const code = await exitWithin(proc, ms)
      if (code === null && proc.exitCode === null) {
        proc.kill('SIGKILL')
        await proc.exited
      }
      return proc.exitCode
    },
  }
}

/** Seed a signed-in CLI instance the way a person's login leaves one: the CLI's own credentials
 *  file (core/cli-instances.ts reads it to call the instance signed in) and a usage reading in the
 *  daemon's usage cache (DATA_DIR/usage-cache.json, keyed cli:<id>), which the CliMayte pool needs
 *  before it hands an account work. Both values are fake; nothing ever sends them anywhere real
 *  (outbound calls go to the refusing proxy). */
export function signIn(home: Home, instance: { id: string; configDir: string }): void {
  mkdirSync(instance.configDir, { recursive: true })
  writeFileSync(
    join(instance.configDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fork-e2e-not-a-token',
        refreshToken: 'fork-e2e-not-a-token',
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: 'max',
      },
    }),
  )
  const cache = join(home.env.AGENTHYDRA_DATA_DIR as string, 'usage-cache.json')
  const all = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : {}
  const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
  all[`cli:${instance.id}`] = {
    account: null,
    session: { pct: 3, resets: '', resetsAt: hours(4) },
    weekAll: { pct: 5, resets: '', resetsAt: hours(5 * 24) },
    weekModel: null,
    extraUsage: false,
    capturedAt: new Date().toISOString(),
    source: 'api',
  }
  writeFileSync(cache, JSON.stringify(all, null, 2))
}

// --- the real HOME ------------------------------------------------------------------------------

/** The developer's own agent homes, as tests/real-home-guard.ts names them, plus AgentHydra's. */
function realRoots(): string[] {
  const home = homedir()
  const roots = [
    '.claude.json',
    '.claude',
    '.codex',
    '.claude-instances',
    '.agenthydra',
    '.hydra-desk-2',
    '.hswarm',
  ].map((n) => join(home, n))
  for (const env of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME])
    if (env) roots.push(resolve(env))
  return [...new Set(roots)]
}

type Snapshot = Map<string, string>

function walk(path: string, out: Snapshot): void {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return
  }
  if (st.isSymbolicLink()) {
    out.set(path, `link ${readlinkSync(path)}`)
  } else if (st.isDirectory()) {
    out.set(path, 'dir')
    let names: string[] = []
    try {
      names = readdirSync(path)
    } catch {
      return
    }
    for (const n of names) walk(join(path, n), out)
  } else {
    let sum = ''
    if (st.size <= 1_048_576) {
      try {
        sum = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
      } catch {
        sum = 'unreadable'
      }
    }
    out.set(path, `${st.size} ${st.mtimeMs} ${sum}`)
  }
}

function snapshot(): Snapshot {
  const out: Snapshot = new Map()
  for (const r of realRoots()) walk(r, out)
  return out
}

/**
 * What a Claude Code session running on this machine writes on its own while the lane runs: its
 * transcripts and session state under ~/.claude, and the rest of ~/.claude.json. Ignored only when
 * the lane itself runs inside such a session (CLAUDECODE is set) and FORK_E2E_STRICT_HOME is not;
 * CI runs strict. Never ignored: settings.json, .credentials.json, hooks and everything else a
 * daemon could write there. AgentHydra's own footprint in ~/.claude.json is the mcpServers key
 * (server/src/mcp-register.ts), so that key is still compared.
 */
const CLAUDE_CODE_OWN =
  /^\.claude\/(projects|sessions|shell-snapshots|todos|statsig|debug|file-history|session-env|ide|backups|skills\/synced)(\/|$)|^\.claude\/(\.last-cleanup|mcp-needs-auth-cache\.json|policy-limits\.json.*|remote-settings\.json.*)$/
const LENIENT = !!process.env.CLAUDECODE && process.env.FORK_E2E_STRICT_HOME !== '1'

function claudeJsonServers(file: string): string {
  try {
    return JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? null)
  } catch {
    return 'unreadable'
  }
}

/** Snapshot the real agent homes now; `changes()` lists every path added, removed or changed since. */
export function realHomeGuard(): { changes(): string[] } {
  const before = snapshot()
  const claudeJson = join(homedir(), '.claude.json')
  const serversBefore = claudeJsonServers(claudeJson)
  return {
    changes() {
      const after = snapshot()
      const changed: string[] = []
      for (const p of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(p)
        const b = after.get(p)
        if (a === b) continue
        const rel = relative(homedir(), p)
        if (LENIENT && (CLAUDE_CODE_OWN.test(rel) || p === claudeJson)) continue
        changed.push(`${a === undefined ? 'added' : b === undefined ? 'removed' : 'changed'} ${p}`)
      }
      if (claudeJsonServers(claudeJson) !== serversBefore)
        changed.push(`changed ${claudeJson} (mcpServers)`)
      return changed
    },
  }
}

// --- scenarios ----------------------------------------------------------------------------------

/**
 * One scenario file's frame: the real-home snapshot taken before anything starts, the homes and
 * daemons it makes, their cleanup, and the closing check that the real HOME was not modified.
 */
export function scenario(name: string) {
  const guard = realHomeGuard()
  const mine: Home[] = []
  const daemons: Daemon[] = []
  const ended = async () => {
    for (const d of daemons) await d.stop('SIGKILL', 5_000)
    for (const h of mine) h.dispose()
    mine.length = 0
  }
  afterAll(ended)
  return {
    home(): Home {
      const h = makeHome(name)
      mine.push(h)
      return h
    },
    async boot(home: Home, opts?: Parameters<typeof bootDaemon>[1]): Promise<Daemon> {
      const d = await bootDaemon(home, opts)
      daemons.push(d)
      return d
    },
    /** The last test of every scenario: everything it started is ended, then the real agent homes
     *  (~/.claude.json, ~/.claude, ~/.codex and their siblings) must be exactly as they were. */
    realHomeUntouched(): void {
      test(`${name}: the real HOME was not modified`, async () => {
        for (const d of daemons) await d.stop('SIGTERM')
        await ended()
        expect(guard.changes()).toEqual([])
      }, 60_000)
    },
  }
}

/** A behaviour this lane states as correct while a known upstream bug still breaks it. The lane
 *  runs with --todo, so the assertion runs on every run and reports as todo while the bug is there
 *  (the lane stays green and the failure is printed); once upstream fixes it, bun fails the test
 *  with "marked as todo but passes", which is the cue to drop the marker. */
export function knownBug(
  bug: { issue: string; where: string },
  name: string,
  fn: () => void | Promise<void>,
): void {
  test.todo(`${name} [known bug, upstream issue to file: ${bug.issue}]`, async () => {
    try {
      await fn()
    } catch (e) {
      const line = `known bug still present (${bug.where}): ${bug.issue}`
      console.warn(`\n  ${line}\n`)
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=fork-e2e known bug::${line}`)
      throw e
    }
  })
}

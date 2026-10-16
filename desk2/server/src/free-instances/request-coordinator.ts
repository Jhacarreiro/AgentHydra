import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { FreeConfig } from '@shared/free-instances'
import { browserPoolPython } from './browser-pool'
import type { FreeRunRequest, RunOutput } from './runner'

export interface RequestCoordinatorEndpoint {
  port: number
  token: string
  version: string
}
const INPUT_LIMIT = 1024 * 1024
const OUTPUT_LIMIT = 16 * 1024 * 1024 + 64 * 1024
const STDOUT_LIMIT = 8 * 1024 * 1024
const REQUEST_MS = 300_000
const FILES = [
  'chatgpt/request_phases.py',
  'chatgpt/request_coordinator.py',
  'chatgpt/request_ownership.py',
  'chatgpt/request_phase_worker.py',
  'chatgpt/browser_slots.py',
  'chatgpt/browser_pool.py',
  'chatgpt/browser_request.py',
  'chatgpt/api.py',
  'chatgpt/http.py',
  'chatgpt/state.py',
  'chatgpt/registry.py',
  'state.py',
  'registry.py',
  'errors.py',
  'http.py',
  'results.py',
]
const OPTIONAL_FILES = ['__init__.py', 'chatgpt/__init__.py']

type StartCoordinator = (
  config: FreeConfig,
  directory: string,
  version: string,
  browserEndpoint: string,
) => Promise<RequestCoordinatorEndpoint>
type EnsureCoordinator = (
  config: FreeConfig,
  browserEndpoint: string,
  signal: AbortSignal,
) => Promise<RequestCoordinatorEndpoint>

/** One startup per service directory. Cancelling a waiter never cancels the server-owned startup. */
export function createRequestCoordinatorStarter(
  start: StartCoordinator = startCoordinator,
): EnsureCoordinator {
  const starting = new Map<string, Promise<RequestCoordinatorEndpoint>>()
  return async (config, browserEndpoint, signal) => {
    if (signal.aborted) throw new Error('stopped')
    const hash = createHash('sha256')
    for (const name of FILES)
      hash.update(name).update(readFileSync(join(config.harnessDir, 'claudfree', name)))
    for (const name of OPTIONAL_FILES) {
      try {
        hash.update(name).update(readFileSync(join(config.harnessDir, 'claudfree', name)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    // A service may only accept accounts under its own state root and use this exact browser pool.
    hash.update(
      JSON.stringify([
        resolve(dirname(config.stateDir)),
        resolve(config.python),
        resolve(browserEndpoint),
      ]),
    )
    const version = hash.digest('hex')
    const directory = join(config.cacheDir, 'chatgpt-request-coordinator', version.slice(0, 16))
    let task = starting.get(directory)
    if (!task) {
      task = Promise.resolve().then(() => start(config, directory, version, browserEndpoint))
      starting.set(directory, task)
      const done = () => {
        if (starting.get(directory) === task) starting.delete(directory)
      }
      void task.then(done, done)
    }
    return new Promise((resolve, reject) => {
      const stopped = () => {
        signal.removeEventListener('abort', stopped)
        reject(new Error('stopped'))
      }
      signal.addEventListener('abort', stopped, { once: true })
      if (signal.aborted) stopped()
      void task.then(
        (value) => {
          signal.removeEventListener('abort', stopped)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', stopped)
          reject(error)
        },
      )
    })
  }
}

export const ensureRequestCoordinator = createRequestCoordinatorStarter()

function readEndpoint(file: string, version: string): RequestCoordinatorEndpoint | undefined {
  try {
    const endpoint = JSON.parse(readFileSync(file, 'utf8')) as RequestCoordinatorEndpoint
    if (
      endpoint.version === version &&
      Number.isInteger(endpoint.port) &&
      endpoint.port > 0 &&
      endpoint.port <= 65535 &&
      /^[a-f0-9]{64}$/.test(endpoint.token)
    )
      return endpoint
  } catch {
    /* absent or an old service is not an available coordinator */
  }
}

async function healthy(
  file: string,
  version: string,
): Promise<RequestCoordinatorEndpoint | undefined> {
  const endpoint = readEndpoint(file, version)
  if (!endpoint) return undefined
  const ok = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: endpoint.port })
    const decoder = new StringDecoder('utf8')
    let text = '',
      bytes = 0,
      settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 1000)
    timer.unref?.()
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
    socket.once('close', () => finish(false))
    socket.once('connect', () =>
      socket.write(JSON.stringify({ op: 'ping', token: endpoint.token }) + '\n'),
    )
    socket.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 4096) return finish(false)
      text += decoder.write(chunk)
      if (!text.includes('\n')) return
      try {
        finish(JSON.parse(text.split('\n')[0]!).ok === true)
      } catch {
        finish(false)
      }
    })
  })
  return ok ? endpoint : undefined
}

async function startCoordinator(
  config: FreeConfig,
  directory: string,
  version: string,
  browserEndpoint: string,
): Promise<RequestCoordinatorEndpoint> {
  const file = join(directory, 'endpoint.json')
  const existing = await healthy(file, version)
  if (existing) return existing
  const python = browserPoolPython(config.python)
  mkdirSync(directory, { recursive: true })
  let launchFailed = false
  const launch = () => {
    const child = spawn(
      python,
      [
        '-m',
        'claudfree.chatgpt.request_coordinator',
        '--directory',
        directory,
        '--version',
        version,
        '--state-root',
        dirname(config.stateDir),
        '--python',
        python,
        '--cache-dir',
        config.cacheDir,
        '--browser-endpoint',
        browserEndpoint,
      ],
      {
        cwd: config.harnessDir,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          CLAUDFREE_CACHE_DIR: config.cacheDir,
        },
      },
    )
    child.once('error', () => {
      launchFailed = true
    })
    child.unref()
    return child
  }
  let child = launch(),
    attempts = 1
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline && !launchFailed) {
    const endpoint = await healthy(file, version)
    if (endpoint) return endpoint
    // Retry only empty service startup if its idle predecessor is still releasing its owner lock.
    if (child.exitCode !== null && attempts < 3) {
      attempts++
      child = launch()
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('request_coordinator_unavailable')
}

/** Undefined means no request write was attempted. After any write, failure is never replayable. */
export async function runCoordinatorRequest(
  endpoint: RequestCoordinatorEndpoint,
  request: FreeRunRequest,
  stateDir: string,
  signal: AbortSignal,
  options: { timeoutMs?: number } = {},
): Promise<RunOutput | undefined> {
  if (signal.aborted) throw new Error('stopped')
  const requestId = randomUUID()
  // Legacy stdin is UTF-8: lone UTF-16 surrogates become replacement characters before Python.
  const wireRequest =
    request.prompt === undefined
      ? request
      : { ...request, prompt: Buffer.from(request.prompt, 'utf8').toString('utf8') }
  const line =
    JSON.stringify({
      op: 'run',
      token: endpoint.token,
      request_id: requestId,
      state_dir: stateDir,
      request: wireRequest,
    }) + '\n'
  if (Buffer.byteLength(line, 'utf8') > INPUT_LIMIT)
    throw new Error('request_coordinator_input_limit')
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | undefined
    let attempted = false,
      accepted = false,
      settled = false,
      bytes = 0,
      text = ''
    const decoder = new StringDecoder('utf8')
    const finish = (out: RunOutput | undefined, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', stopped)
      socket?.destroy()
      if (error) reject(error)
      else resolve(out)
    }
    const stopped = () => finish(undefined, new Error('stopped'))
    // One absolute request budget, not an idle timeout reset by progress or partial output.
    const timer = setTimeout(stopped, options.timeoutMs ?? REQUEST_MS)
    timer.unref?.()
    const failed = (message: string) =>
      finish(undefined, attempted ? new Error(message) : undefined)
    const readLine = (line: string) => {
      if (settled) return
      let message: Record<string, unknown>
      try {
        const value = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
        message = value
      } catch {
        return failed('request_coordinator_malformed: completion is unknown; do not replay')
      }
      if (message.request_id !== requestId)
        return failed('request_coordinator_wrong_request: completion is unknown; do not replay')
      if ('accepted' in message) {
        if (message.accepted !== true || accepted)
          return failed('request_coordinator_refused: request was not replayed')
        accepted = true
        return
      }
      if ('code' in message || 'stdout' in message) {
        if (!accepted || !Number.isInteger(message.code) || typeof message.stdout !== 'string')
          return failed('request_coordinator_malformed: completion is unknown; do not replay')
        if (Buffer.byteLength(message.stdout, 'utf8') > STDOUT_LIMIT)
          return failed('request_coordinator_output_limit')
        finish({ code: message.code as number, stdout: message.stdout })
      }
      // Optional progress is ignored, but only after its request identity was checked above.
    }
    signal.addEventListener('abort', stopped, { once: true })
    if (signal.aborted) return stopped()
    try {
      socket = connect({ host: '127.0.0.1', port: endpoint.port })
      socket.once('connect', () => {
        if (settled) return
        attempted = true // Even a synchronous write failure is not safe to replay.
        try {
          socket!.write(line)
        } catch {
          failed('request_coordinator_write_unknown: do not replay')
        }
      })
      socket.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > OUTPUT_LIMIT) return failed('request_coordinator_output_limit')
        text += decoder.write(chunk)
        while (!settled) {
          const end = text.indexOf('\n')
          if (end < 0) break
          const line = text.slice(0, end)
          text = text.slice(end + 1)
          readLine(line)
        }
      })
      socket.once('error', () => failed('request_coordinator_connection_unknown: do not replay'))
      socket.once('end', () => {
        text += decoder.end()
        if (text && !settled) readLine(text)
        if (!settled) failed('request_coordinator_completion_unknown: do not replay')
      })
      socket.once('close', () => failed('request_coordinator_completion_unknown: do not replay'))
    } catch {
      failed('request_coordinator_connection_unknown: do not replay')
    }
  })
}

/** Legacy fallback is allowed only before dispatch, never for an unknown or refused operation. */
export async function runCoordinatedFree(
  config: FreeConfig,
  request: FreeRunRequest,
  browserEndpoint: string,
  signal: AbortSignal,
  options: { platform?: NodeJS.Platform; ensure?: EnsureCoordinator } = {},
): Promise<RunOutput | undefined> {
  if (signal.aborted) throw new Error('stopped')
  if (
    (options.platform ?? process.platform) !== 'win32' ||
    request.provider !== 'chatgpt' ||
    (request.command !== 'chat' && request.command !== 'resume')
  )
    return undefined
  let endpoint: RequestCoordinatorEndpoint
  try {
    endpoint = await (options.ensure ?? ensureRequestCoordinator)(config, browserEndpoint, signal)
  } catch {
    if (signal.aborted) throw new Error('stopped')
    return undefined
  }
  if (signal.aborted) throw new Error('stopped')
  return runCoordinatorRequest(endpoint, request, config.stateDir, signal)
}

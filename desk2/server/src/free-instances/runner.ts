import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FreeConfig, FreeHarnessCommand, FreeRequest } from '@shared/free-instances'
import { SpawnLaunchError, spawnOff, type SpawnOffOptions, type SpawnOffResult } from '../lib/spawn-off'
import { ensureBrowserPool } from './browser-pool'
import { launchRunner, LeftRunning, outputOf, watchRunner, type JobPaths } from './jobs'
import { coordinatorEndpoint, runCoordinatedFree } from './request-coordinator'

export interface RunOutput { code: number; stdout: string }
export type FreeRunRequest = Omit<FreeRequest, 'command'> & { command: FreeHarnessCommand }
/** An operation Desk keeps across a restart (jobs.ts): its harness runs under a runner of its own. */
export interface FreeDetach {
  paths: JobPaths
  /** Asked just before the runner is started: false when Desk is stopping, and nothing starts. From a true on, the
   *  operation is its runner's, and Desk's stop leaves it running. */
  launching(): boolean
  /** Desk's stop: the wait for the runner ends, the runner goes on. */
  leave: AbortSignal
}
export type FreeRunner = (config: FreeConfig, request: FreeRunRequest, signal: AbortSignal, detach?: FreeDetach) => Promise<RunOutput>
// The existing browser slots admit three. Only additional waiters need the lightweight coordinator.
let admittedChatGPT = 0

/** Counts a ChatGPT message on the browser slots until `release`; `coordinate` past the three slots. A message the
 *  last Desk started and this one watches (FreeInstances.reattach) counts as well. */
export function admitChatGPT(): { coordinate: boolean; release: () => void } {
  const coordinate = ++admittedChatGPT > 3
  let released = false
  return { coordinate, release: () => { if (!released) { released = true; admittedChatGPT-- } } }
}

/** Decode the transferred output slice without copying its full byte buffer first. */
export function decodeFreeStdout(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
}

/** No shell, credentials in argv, browser fallback, or automatic message retries. */
export function commandArgs(config: FreeConfig, request: FreeRunRequest): string[] {
  const args = [join(config.harnessDir, 'desk_entry.py'), request.command]
  // The harness refuses --json with forget, and forget prints a sentence: its exit code is the result.
  if (request.command === 'forget') return [...args, '--provider', request.provider, '--request-timeout', '120']
  // Sign-in: desk_entry prints the JSON itself, and the harness refuses --json and --brief with login.
  if (request.command === 'login') return [...args, '--provider', request.provider, '--timeout', '900']
  if (request.chatId) args.push(request.chatId)
  args.push('--provider', request.provider, '--json', '--brief', '--request-timeout', '120')
  if (request.command === 'chat' || request.command === 'resume') args.push('--stdin')
  // Registry aliases are restricted; Desk keeps the friendly display name separately.
  if (request.name) args.push('--name', `desk-${createHash('sha256').update(request.name).digest('hex').slice(0, 24)}`)
  if (request.webSearch) args.push('--web-search')
  if (request.model) args.push('--prefer', request.model)
  return args
}

/** The spawn runs on the spawn-off worker, so a busy PC cannot stall the server's loop while Python starts. With
 *  `detach` it runs under a runner of its own (jobs.ts), which a Desk restart leaves running. */
export const runFree: FreeRunner = async (config, request, signal, detach) => {
  if (signal.aborted) throw new Error('stopped')
  const chatGPT = request.provider === 'chatgpt' && (request.command === 'chat' || request.command === 'resume')
  const admitted = chatGPT ? admitChatGPT() : undefined
  let launched = false
  let out: SpawnOffResult
  try {
    const pool = chatGPT ? await ensureBrowserPool(config, signal) : undefined
    if (signal.aborted) throw new Error('stopped')
    const spawn: SpawnOffOptions = {
      cmd: [config.python, ...commandArgs(config, request)],
      cwd: config.harnessDir,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', CLAUDFREE_STATE_DIR: config.stateDir, CLAUDFREE_CACHE_DIR: config.cacheDir, CLAUDFREE_BROWSER_POOL: pool ?? '' },
      stdin: request.prompt ?? '',
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: request.command === 'login' ? 960_000 : 300_000,
      stderr: 'ignore',
      killTree: true,
    }
    if (detach) {
      const endpoint = pool && admitted?.coordinate ? await coordinatorEndpoint(config, pool, signal) : undefined
      if (!detach.launching()) throw new LeftRunning()
      launched = true
      const failed = launchRunner(detach.paths, { id: request.requestId, spawn, ...(endpoint ? { coordinator: { endpoint, request, stateDir: config.stateDir } } : {}) })
      return outputOf(await watchRunner(detach.paths, request.requestId, { cancel: signal, leave: detach.leave, failed }))
    }
    if (pool && admitted?.coordinate) {
      const coordinated = await runCoordinatedFree(config, request, pool, signal)
      if (coordinated !== undefined) return coordinated
    }
    out = await spawnOff(spawn, signal)
  } catch (err) {
    // Desk stopped while this was being set up: nothing reached the provider, and the next Desk runs it from the start.
    if (detach?.leave.aborted && !launched) throw new LeftRunning()
    if (err instanceof SpawnLaunchError) throw new Error('launch_failed')
    throw err
  } finally {
    admitted?.release()
  }
  if (out.aborted || out.capped || out.timedOut) throw new Error('stopped')
  return { code: out.code, stdout: decodeFreeStdout(out.stdout) }
}

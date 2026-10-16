import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { FreeConfig } from '@shared/free-instances'

interface Endpoint { port: number; token: string; version: string }
const starting = new Map<string, Promise<string>>()

/** One server-owned process, outside disposable CLI jobs' cancellation trees. */
export async function ensureBrowserPool(config: FreeConfig, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('stopped')
  const version = createHash('sha256')
  for (const name of ['chatgpt/browser_pool.py', 'chatgpt/browser_request.py', 'chatgpt/http.py', 'signin.py', 'state.py', 'errors.py', 'registry.py']) {
    version.update(readFileSync(join(config.harnessDir, 'claudfree', name)))
  }
  const signature = version.digest('hex')
  const directory = join(config.cacheDir, 'chatgpt-browser-pool', signature.slice(0, 16))
  let task = starting.get(directory)
  if (!task) {
    task = start(config, directory, signature)
    starting.set(directory, task)
    void task.then(() => starting.delete(directory), () => starting.delete(directory))
  }
  // Startup is server-owned: one cancelled request must not cancel other waiters.
  return new Promise((resolve, reject) => {
    const stopped = () => { signal.removeEventListener('abort', stopped); reject(new Error('stopped')) }
    signal.addEventListener('abort', stopped, { once: true })
    if (signal.aborted) stopped()
    void task.then(value => { signal.removeEventListener('abort', stopped); resolve(value) },
      error => { signal.removeEventListener('abort', stopped); reject(error) })
  })
}

async function start(config: FreeConfig, directory: string, version: string): Promise<string> {
  const file = join(directory, 'endpoint.json')
  if (await healthy(file, version)) return file
  mkdirSync(directory, { recursive: true })
  // No account credentials, prompts or cookies are passed on the command line.
  let launchFailed = false
  const launch = () => {
    const child = spawn(config.python, ['-m', 'claudfree.chatgpt.browser_pool', '--directory', directory, '--version', version], {
      cwd: config.harnessDir, windowsHide: true, detached: true, stdio: 'ignore',
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }
    })
    child.once('error', () => { launchFailed = true })
    child.unref()
    return child
  }
  let child = launch()
  let attempts = 1
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline && !launchFailed) {
    if (await healthy(file, version)) return file
    // An idle broker may still hold its owner lock while closing Chrome. This
    // retries only empty service startup, never a login or generation request.
    if (child.exitCode !== null && attempts < 3) { attempts++; child = launch() }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('browser_pool_unavailable')
}

async function healthy(file: string, version: string): Promise<boolean> {
  let endpoint: Endpoint
  try {
    endpoint = JSON.parse(readFileSync(file, 'utf8')) as Endpoint
    if (endpoint.version !== version || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) return false
  } catch { return false }
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port: endpoint.port })
    let bytes = ''
    let settled = false
    const finish = (ok: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve(ok) } }
    socket.setTimeout(1000, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
    socket.once('connect', () => socket.write(JSON.stringify({ op: 'ping', token: endpoint.token }) + '\n'))
    socket.on('data', chunk => {
      bytes += chunk.toString('utf8')
      if (bytes.length > 4096) return finish(false)
      if (!bytes.includes('\n')) return
      try { finish((JSON.parse(bytes.split('\n')[0]!) as { ok?: boolean }).ok === true) } catch { finish(false) }
    })
  })
}

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { measureInPage } from './measure-dom.mjs'

export const VIEWPORTS = [
  { name: 'desktop', width: 1366, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
]

const BROWSERS = [
  process.env.PRICECHECK_BROWSER,
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
]

export function findBrowser() {
  return BROWSERS.find((p) => p && existsSync(p) && statSync(p).isFile()) ?? null
}

async function readDevToolsPort(dir, exited, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const [port, path] = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')
      if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`
    } catch {}
    if (exited.done) break
    await delay(100)
  }
  throw new Error('pricecheck live: the browser did not open a DevTools port')
}

function track(proc) {
  const state = { done: false }
  const exited = new Promise((resolve) => {
    const finish = () => {
      state.done = true
      resolve()
    }
    proc.once('exit', finish)
    proc.once('error', finish)
  })
  return Object.assign(state, { exited })
}

async function launchBrowser() {
  const exe = findBrowser()
  if (!exe) throw new Error('pricecheck live: no Chrome or Edge found (set PRICECHECK_BROWSER, or pass --cdp <endpoint>)')
  const dir = await mkdtemp(join(tmpdir(), 'pricecheck-live-'))
  const proc = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  const status = track(proc)
  const killOnExit = () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill()
  }
  process.once('exit', killOnExit)
  const browser = { proc, status, dir, killOnExit, endpoint: null }
  try {
    browser.endpoint = await readDevToolsPort(dir, status, 15000)
    return browser
  } catch (err) {
    await stopBrowser(browser)
    throw err
  }
}

async function stopBrowser(browser) {
  const { proc, status, dir } = browser
  process.off('exit', browser.killOnExit)
  if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else proc.kill('SIGKILL')
    await Promise.race([status.exited, delay(5000)])
  }
  if (dir) await removeProfile(dir)
}

// Chrome releases its profile files a moment after it exits; on Windows they stay locked until then.
async function removeProfile(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 40 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err
      await delay(250)
    }
  }
}

async function resolveEndpoint(cdp) {
  if (/^wss?:\/\//.test(cdp)) return cdp
  const res = await fetch(`${cdp.replace(/\/+$/, '')}/json/version`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`pricecheck live: ${cdp} answered ${res.status} to /json/version`)
  const { webSocketDebuggerUrl } = await res.json()
  if (!webSocketDebuggerUrl) throw new Error(`pricecheck live: ${cdp} has no webSocketDebuggerUrl`)
  return webSocketDebuggerUrl
}

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const listeners = new Set()
  let nextId = 0
  const failAll = (err) => {
    for (const { reject } of pending.values()) reject(err)
    pending.clear()
  }
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`pricecheck live: cannot reach the browser at ${url}`))
  })
  ws.onclose = () => failAll(new Error('pricecheck live: the browser connection closed'))
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
      return
    }
    for (const fn of listeners) fn(msg)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const once = (method, sessionId, timeoutMs) => {
    let fn
    const hit = new Promise((resolve) => {
      fn = (msg) => {
        if (msg.method === method && msg.sessionId === sessionId) resolve()
      }
      listeners.add(fn)
    })
    const timer = delay(timeoutMs, null, { ref: false }).then(() => {
      throw new Error(`pricecheck live: ${method} did not arrive within ${timeoutMs} ms`)
    })
    return Promise.race([hit, timer]).finally(() => listeners.delete(fn))
  }
  return { ready, send, once, close: () => ws.close() }
}

async function measureViewport(client, url, viewport, root) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  try {
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    await client.send('Page.enable', {}, sessionId)
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile },
      sessionId,
    )
    const loaded = client.once('Page.loadEventFired', sessionId, 30000)
    const nav = await client.send('Page.navigate', { url }, sessionId)
    if (nav.errorText) throw new Error(`pricecheck live: could not open ${url} (${nav.errorText})`)
    await loaded
    const expression = `(${measureInPage.toString()})(${JSON.stringify({ root })})`
    const { result, exceptionDetails } = await client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      sessionId,
    )
    if (exceptionDetails) throw new Error(`pricecheck live: measuring ${url} failed: ${exceptionDetails.text}`)
    return { name: viewport.name, ...result.value }
  } finally {
    await client.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

// One result per viewport: { name, viewport: { width, height }, items: [{ unit, file, count }] }.
export async function measureUrl(url, { cdp = null, root = process.cwd(), viewports = VIEWPORTS } = {}) {
  const browser = cdp ? null : await launchBrowser()
  const client = connect(cdp ? await resolveEndpoint(cdp) : browser.endpoint)
  try {
    await client.ready
    const results = []
    for (const viewport of viewports) results.push(await measureViewport(client, url, viewport, root))
    return results
  } finally {
    client.close()
    if (browser) await stopBrowser(browser)
  }
}

export { launchBrowser, stopBrowser }

// A Free operation outlives a Desk restart (owner, 2026-10-17: each part of AgentHydra restarts on its own without
// breaking the others). Before, FreeInstances.stop() aborted every running operation, and operations lived only in
// Desk's memory: after POST /api/server/restart the daemon read 404 and reported operation_lost, while the provider turn
// may or may not have landed. The harness now runs under a runner outside Desk's process tree (free-instances/jobs.ts,
// job-runner.ts), and each operation's record is on disk, so the next service answers it and carries it on.
//
// The harness here is a stand-in, run by bun under the name desk_entry.py: it says it started, waits for a `go` file,
// then prints a reply. Everything else is the production path: runFree, the detached launch, the runner and the watch.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeJob, FreeRequest } from '../../shared/free-instances'
import { pidAlive } from '../src/host/launch'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeInstances } from '../src/free-instances/service'

const CHAT = '11111111-2222-4333-8444-555555555555'
const HARNESS = `import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const prompt = await Bun.stdin.text()
appendFileSync(join(import.meta.dir, 'starts.txt'), process.pid + '\\n')
while (!existsSync(join(import.meta.dir, 'go'))) await Bun.sleep(20)
console.log(JSON.stringify({ ok: true, chat_id: '${CHAT}', is_temporary: true, messages: [], response: 'Synthetic reply to: ' + prompt }))
`

const homes: string[] = []
const services: FreeInstances[] = []
const holds: (() => void)[] = []

afterEach(async () => {
  for (const home of homes) writeFileSync(join(home, 'harness', 'go'), '')
  for (const release of holds.splice(0)) release()
  await Promise.all(services.splice(0).map((service) => service.stop()))
  // Every harness and runner ends before its folder goes (a harness's working folder is in it).
  const pids = homes.flatMap((home) => [...starts(home), ...runners(home)])
  const deadline = Date.now() + 15_000
  while (pids.some(pidAlive) && Date.now() < deadline) await Bun.sleep(50)
  for (const pid of pids.filter(pidAlive)) process.kill(pid)
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function starts(home: string): number[] {
  const file = join(home, 'harness', 'starts.txt')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []
}

function runners(home: string): number[] {
  const dir = join(home, 'free', 'jobs')
  if (!existsSync(dir)) return []
  return [...new Bun.Glob('*.run.json').scanSync(dir)].map((name) => (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { pid: number }).pid)
}

function desk(): { home: string; runtime: FreeRuntime; open: (runtime?: FreeRuntime) => FreeInstances } {
  const home = mkdtempSync(join(tmpdir(), 'free-job-restart-'))
  homes.push(home)
  mkdirSync(join(home, 'harness'))
  writeFileSync(join(home, 'harness', 'desk_entry.py'), HARNESS)
  const runtime: FreeRuntime = {
    ready: () => true,
    ensure: async () => {},
    config: (id) => ({ harnessDir: join(home, 'harness'), python: process.execPath, stateDir: join(home, 'free', 'instances', id), cacheDir: join(home, 'cache') }),
  }
  const open = (r: FreeRuntime = runtime): FreeInstances => {
    const service = new FreeInstances(home, undefined, r)
    services.push(service)
    return service
  }
  return { home, runtime, open }
}

async function until<T>(read: () => T | null | undefined | false, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

function message(service: FreeInstances): FreeRequest {
  const account = service.create({ provider: 'claude', name: 'Synthetic account' })
  account.email = 'account@example.test'
  return { requestId: crypto.randomUUID(), instanceId: account.id, provider: 'claude', command: 'chat', prompt: 'Synthetic message' }
}

const finished = (service: FreeInstances, id: string) => until(() => { const job = service.get(id); return job.state === 'done' && job }, 'the operation to finish')

test('a message running when Desk stops finishes under the next Desk with its reply, sent once, and is answered after another restart', async () => {
  const d = desk()
  const first = d.open()
  const request = message(first)
  first.start(request)
  const [pid] = await until(() => starts(d.home).length > 0 && starts(d.home), 'the harness to start')
  await first.stop()
  expect(pidAlive(pid!)).toBe(true)

  const second = d.open()
  expect(second.getMany([request.requestId])[request.requestId]).toMatchObject({ state: 'running' })
  // The daemon resends a send it lost track of under the same request id: the same operation, not a second message.
  expect(second.start({ ...request })).toBe(second.get(request.requestId))
  writeFileSync(join(d.home, 'harness', 'go'), '')
  const job: FreeJob = await finished(second, request.requestId)
  expect(job.result).toMatchObject({ ok: true, chat_id: CHAT, response: 'Synthetic reply to: Synthetic message' })
  expect(second.threads().find((t) => t.chatId === CHAT)?.status).toBe('done')
  await second.settled()
  await second.stop()

  const third = d.open()
  expect(third.get(request.requestId).result).toMatchObject({ ok: true, response: 'Synthetic reply to: Synthetic message' })
  expect(third.start({ ...request })).toBe(third.get(request.requestId))
  expect(starts(d.home)).toHaveLength(1)
}, 90_000)

test('a message Desk took but had not started when it stopped is started by the next Desk', async () => {
  const d = desk()
  // Setup (the runtime's install check) is still going when Desk stops.
  const setup = new Promise<void>((resolve) => holds.push(resolve))
  const first = d.open({ ...d.runtime, ensure: () => setup })
  const request = message(first)
  first.start(request)
  await first.stop()
  expect(starts(d.home)).toHaveLength(0)

  writeFileSync(join(d.home, 'harness', 'go'), '')
  const second = d.open()
  expect(second.get(request.requestId).state).toBe('running')
  const job = await finished(second, request.requestId)
  expect(job.result).toMatchObject({ ok: true, response: 'Synthetic reply to: Synthetic message' })
  expect(starts(d.home)).toHaveLength(1)
}, 90_000)

test('a cancel ends the harness under its runner', async () => {
  const d = desk()
  const service = d.open()
  const request = message(service)
  service.start(request)
  const [pid] = await until(() => starts(d.home).length > 0 && starts(d.home), 'the harness to start')
  service.cancel(request.requestId)
  const job = await finished(service, request.requestId)
  expect(job.result?.error?.code).toBe('operation_interrupted')
  await until(() => !pidAlive(pid!), 'the harness to end', 10_000)
}, 90_000)

test('an operation whose runner is killed ends as interrupted, and its account takes the next one', async () => {
  const d = desk()
  const service = d.open()
  const request = message(service)
  service.start(request)
  await until(() => starts(d.home).length > 0, 'the harness to start')
  const [runner] = await until(() => runners(d.home).length > 0 && runners(d.home), 'the runner to say it runs')
  process.kill(runner!, 'SIGKILL')
  const job = await finished(service, request.requestId)
  expect(job.result?.error?.code).toBe('operation_interrupted')
  writeFileSync(join(d.home, 'harness', 'go'), '')
  const next = service.start({ ...request, requestId: crypto.randomUUID() })
  expect((await finished(service, next.id)).result).toMatchObject({ ok: true })
}, 90_000)

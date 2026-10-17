import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeJob, FreeRequest, FreeThread } from '../../shared/free-instances'
import type { FreeRuntime } from '../src/free-instances/runtime'
import type { FreeRunner, RunOutput } from '../src/free-instances/runner'
import { FreeInstances } from '../src/free-instances/service'

const homes: string[] = []
const services: FreeInstances[] = []
const release: (() => void)[] = []
const spies: { mockRestore(): void }[] = []
afterEach(async () => {
  for (const done of release.splice(0)) done()
  await Promise.all(services.splice(0).map((service) => service.stop()))
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

type Retained = {
  jobs: Map<string, FreeJob>
  fingerprints: Map<string, string>
  store: { data: { threads: FreeThread[] } }
}

test('the idle refresh expires only old completed recovery replies without running an account check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'free-idle-retention-'))
  homes.push(home)
  const chatId = '11111111-2222-4333-8444-555555555555'
  let now = 1_800_000_000_000
  spies.push(spyOn(Date, 'now').mockImplementation(() => now))
  const result: RunOutput = {
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      chat_id: chatId,
      is_temporary: true,
      messages: [],
      response: 'Synthetic retained reply '.repeat(40_000),
    }),
  }
  let unblock!: () => void
  const pending = new Promise<void>((resolve) => {
    unblock = resolve
  })
  release.push(unblock)
  let calls = 0
  const runner: FreeRunner = async () => {
    calls++
    if (calls === 3) await pending
    return result
  }
  const runtime: FreeRuntime = {
    ready: () => true,
    ensure: async () => {},
    config: (id) => ({
      harnessDir: home,
      python: join(home, 'unused-python.exe'),
      stateDir: join(home, 'free', 'instances', id),
      cacheDir: join(home, 'cache'),
    }),
  }
  const service = new FreeInstances(home, runner, runtime)
  services.push(service)
  const account = service.create({ provider: 'chatgpt', name: 'Synthetic account' })
  account.email = 'account@example.test'
  const operation = (): FreeRequest => ({
    requestId: crypto.randomUUID(),
    instanceId: account.id,
    provider: 'chatgpt',
    command: 'read',
    chatId,
  })
  const finish = async (job: FreeJob) => {
    const deadline = performance.now() + 2000
    while (job.state !== 'done') {
      if (performance.now() >= deadline) throw new Error('Synthetic job did not finish')
      await Bun.sleep(1)
    }
  }
  const old = service.start(operation())
  await finish(old)
  now += 10_000
  const fresh = service.start(operation())
  await finish(fresh)
  const running = service.start(operation())
  const startedBy = performance.now() + 2000
  while (calls < 3) {
    if (performance.now() >= startedBy) throw new Error('Synthetic pending job did not start')
    await Bun.sleep(1)
  }
  const retained = service as unknown as Retained
  const threads = JSON.stringify(retained.store.data.threads)
  now = old.finishedAt! + 15 * 60_000
  service.refreshNext()
  expect(retained.jobs.size).toBe(3)
  expect(calls).toBe(3)
  now++
  service.refreshNext()
  expect(retained.jobs.has(old.id)).toBe(false)
  expect(retained.fingerprints.has(old.id)).toBe(false)
  expect(retained.jobs.get(fresh.id)).toBe(fresh)
  expect(retained.fingerprints.has(fresh.id)).toBe(true)
  expect(retained.jobs.get(running.id)).toBe(running)
  expect(retained.fingerprints.has(running.id)).toBe(true)
  expect(running.state).toBe('running')
  expect(calls).toBe(3)
  expect(JSON.stringify(retained.store.data.threads)).toBe(threads)
  unblock()
  await finish(running)
  await service.stop()
  service.refreshNext()
  expect(calls).toBe(3)
})

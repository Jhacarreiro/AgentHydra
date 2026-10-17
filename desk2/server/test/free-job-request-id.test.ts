// The daemon resends a send it was cut off from under the same request id after a restart (AgentHydra
// server/src/mcp-free.ts Item.sendingAt). That only sends once because Desk answers a request id it already
// holds with that operation instead of running the account again.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeJob, FreeRequest } from '../../shared/free-instances'
import type { FreeRunner, RunOutput } from '../src/free-instances/runner'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeInstances } from '../src/free-instances/service'

const homes: string[] = []
const services: FreeInstances[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test('a request id Desk already holds answers with its operation, so a resent message runs once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'free-request-id-'))
  homes.push(home)
  const chatId = '11111111-2222-4333-8444-555555555555'
  let runs = 0
  let finishRun!: () => void
  const held = new Promise<void>((resolve) => {
    finishRun = resolve
  })
  const output: RunOutput = {
    code: 0,
    stdout: JSON.stringify({ ok: true, chat_id: chatId, is_temporary: true, messages: [], response: 'Synthetic reply' }),
  }
  const runner: FreeRunner = async () => {
    runs++
    await held
    return output
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
  const request: FreeRequest = {
    requestId: crypto.randomUUID(),
    instanceId: account.id,
    provider: 'chatgpt',
    command: 'chat',
    prompt: 'Synthetic message',
  }
  const first = service.start(request)
  const startedBy = performance.now() + 2000
  while (runs < 1) {
    if (performance.now() >= startedBy) throw new Error('Synthetic operation did not start')
    await Bun.sleep(1)
  }
  // While it runs, and on an account that is busy with it: the same operation, not a second run.
  expect(service.start({ ...request })).toBe(first)
  finishRun()
  const doneBy = performance.now() + 2000
  while ((first as FreeJob).state !== 'done') {
    if (performance.now() >= doneBy) throw new Error('Synthetic operation did not finish')
    await Bun.sleep(1)
  }
  // After it finished: the finished operation and its reply.
  expect(service.start({ ...request })).toBe(first)
  expect(runs).toBe(1)
  // The same id with another message is refused, never taken for the first one.
  expect(() => service.start({ ...request, prompt: 'Another synthetic message' })).toThrow('another operation')
})

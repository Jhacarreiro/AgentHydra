// Terminal result retention must not retain the original prompts or a no-longer-needed full history.
import { expect, test } from 'bun:test'
import { releaseFreeBatchInputs } from '../src/mcp-free'

type Item = Parameters<typeof releaseFreeBatchInputs>[0][number]
type HistoryCache = NonNullable<Parameters<typeof releaseFreeBatchInputs>[1]>

function item(state: Item['s']['state'], index = 0, continuation = false): Item {
  return {
    task: {
      prompt: `Synthetic task ${index}: ${'x'.repeat(99_900)}`,
      name: 'Synthetic thread',
      provider: 'claude',
      model: 'haiku',
      web_search: true,
      ...(continuation ? { chat_id: '11111111-1111-4111-8111-111111111111' } : {}),
    },
    s: {
      task: index,
      state,
      account: '#1 claude (Example account)',
      chat_id: '11111111-1111-4111-8111-111111111111',
      thread: 'Synthetic thread',
      model: 'haiku',
      response: 'Synthetic retained answer',
      error: state === 'failed' ? 'Synthetic retained error' : undefined,
      warnings: ['Synthetic warning'],
      seconds: 2,
    },
  }
}

function cache(count = 36_000): HistoryCache {
  return {
    threads: Array.from({ length: count }, (_, index) => ({
      instanceId: 'synthetic-account',
      provider: 'claude' as const,
      chatId: `synthetic-chat-${index}`,
      title: 'Synthetic history',
      status: 'done',
      createdAt: index,
      updatedAt: index,
      error: null,
    })),
  }
}

test('a completed 32-task batch drops over 3 million input characters while retaining exact results', () => {
  const items = Array.from({ length: 32 }, (_, index) => item(index % 2 ? 'failed' : 'done', index))
  const expected = structuredClone(items.map((it) => it.s))
  const taskOptions = items.map(({ task: { prompt: _prompt, ...options } }) => options)
  expect(items.reduce((sum, it) => sum + it.task.prompt.length, 0)).toBeGreaterThan(3_000_000)
  releaseFreeBatchInputs(items)
  expect(items.reduce((sum, it) => sum + it.task.prompt.length, 0)).toBe(0)
  expect(items.map((it) => it.s)).toEqual(expected)
  expect(items.map(({ task: { prompt: _prompt, ...options } }) => options)).toEqual(taskOptions)
})

test('queued, running and retrying tasks retain the exact prompt until a terminal decision', () => {
  const queued = item('queued')
  const running = item('running', 1)
  const retrying = item('queued', 2)
  retrying.s.retried = 'Synthetic earlier account refusal'
  const done = item('done', 3)
  const failed = item('failed', 4)
  const expected = [queued.task.prompt, running.task.prompt, retrying.task.prompt]
  releaseFreeBatchInputs([queued, running, retrying, done, failed])
  expect([queued.task.prompt, running.task.prompt, retrying.task.prompt]).toEqual(expected)
  expect(done.task.prompt).toBe('')
  expect(failed.task.prompt).toBe('')
  retrying.s.state = 'done'
  releaseFreeBatchInputs([retrying])
  expect(retrying.task.prompt).toBe('')
})

test('a queued continuation keeps its history lookup, then releases it immediately after starting', () => {
  const continuation = item('queued', 0, true)
  const queuedNewThread = item('queued', 1)
  const history = cache()
  const original = history.threads
  releaseFreeBatchInputs([continuation, queuedNewThread], history)
  expect(history.threads).toBe(original)
  continuation.s.state = 'running'
  const prompt = continuation.task.prompt
  releaseFreeBatchInputs([continuation, queuedNewThread], history)
  expect(history.threads).toBeNull()
  expect(continuation.task.prompt).toBe(prompt)
  expect(continuation.task.chat_id).toBe('11111111-1111-4111-8111-111111111111')
})

test('completed or failed continuations release history without dropping public state', () => {
  const items = [item('done', 0, true), item('failed', 1, true)]
  const states = items.map((it) => it.s)
  const history = cache(2)
  releaseFreeBatchInputs(items, history)
  expect(history.threads).toBeNull()
  expect(items.map((it) => it.task.prompt)).toEqual(['', ''])
  expect(items[0]!.s).toBe(states[0]!)
  expect(items[1]!.s).toBe(states[1]!)
  expect(items[0]!.s.response).toBe('Synthetic retained answer')
  expect(items[1]!.s.error).toBe('Synthetic retained error')
})

test('repeated result snapshots release idempotently and leave results and capability state intact', () => {
  const terminal = item('done')
  const state = terminal.s
  const warnings = terminal.s.warnings
  const history = { ...cache(1), bulkJobs: true }
  releaseFreeBatchInputs([terminal], history)
  releaseFreeBatchInputs([terminal], history)
  expect(terminal.task.prompt).toBe('')
  expect(terminal.s).toBe(state)
  expect(terminal.s.warnings).toBe(warnings)
  expect(history).toEqual({ threads: null, bulkJobs: true })
})

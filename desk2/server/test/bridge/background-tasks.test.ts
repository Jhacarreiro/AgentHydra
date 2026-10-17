// An outside session's open background tasks, read from transcript lines of the shapes Claude Code writes
// (background-tasks.ts): what opens a task, what ends it, what never counts, and the reader that only reads appends.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackgroundTasks, foldText, newScan } from '../../src/bridge/background-tasks'

const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 12, min)).toISOString()

/** The assistant line holding a launching call. */
const call = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', timestamp: at(0), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
/** The user line holding its result, with the toolUseResult Claude Code records beside it. */
const result = (id: string, text: string, toolUseResult: Record<string, unknown>, min = 1) =>
  JSON.stringify({ type: 'user', timestamp: at(min), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text }] }, toolUseResult })
/** A task notification as the queue records it. */
const notice = (taskId: string, inner: string, min = 2) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(min), content: `<task-notification>\n<task-id>${taskId}</task-id>\n${inner}\n</task-notification>` })

const bash = (n: string, command = 'bash deploy.sh') => [
  call(`toolu_${n}`, 'Bash', { command, description: 'Run the deploy', run_in_background: true }),
  result(`toolu_${n}`, `Command running in background with ID: ${n}. Output is being written to: C:/Users/me/out.`, { stdout: '', stderr: '', backgroundTaskId: n }),
]
const monitor = (n: string, persistent = false) => [
  call(`toolu_${n}`, 'Monitor', { command: 'tail -f log', description: 'deploy finishing', timeout_ms: 1_200_000, persistent }),
  result(`toolu_${n}`, `Monitor started (task ${n}, expires in 20m).`, { taskId: n, timeoutMs: 1_200_000, persistent }),
]

const openIds = (lines: string[]) => {
  const scan = newScan()
  foldText(scan, lines.join('\n'))
  return [...scan.open.keys()]
}

describe('which tasks a transcript leaves open', () => {
  test('a background command, a Monitor and a background workflow are open until their end is written', () => {
    const workflow = result('toolu_w', 'Workflow launched in background. Task ID: w1', { status: 'async_launched', taskId: 'w1', taskType: 'local_workflow' })
    expect(openIds([...bash('b1'), ...monitor('m1'), workflow])).toEqual(['b1', 'm1', 'w1'])
    expect(openIds(bash('b1'))).toEqual(['b1'])
    expect(openIds([...bash('b1'), notice('b1', '<status>completed</status>\n<summary>Background command "Run the deploy" completed (exit code 0)</summary>')])).toEqual([])
    expect(openIds([...bash('b1'), notice('b1', '<status>failed</status>')])).toEqual([])
  })

  test("a Monitor's events keep it open; its expiry ends it", () => {
    const event = (e: string) => notice('m1', `<summary>Monitor event: "deploy finishing"</summary>\n<event>${e}</event>`)
    expect(openIds([...monitor('m1'), event('step 3 of 9 done')])).toEqual(['m1'])
    expect(openIds([...monitor('m1'), event('[Monitor expired after 20m with no events delivered.]')])).toEqual([])
  })

  test('a TaskStop result ends a task, which most stops never notify', () => {
    const stop = result('toolu_s', 'stopped', { message: 'Successfully stopped task: b1 (bash deploy.sh)', command: 'bash deploy.sh' }, 3)
    expect(openIds([...bash('b1'), stop])).toEqual([])
  })

  test('tasks that never end by themselves do not count: a local server, a persistent Monitor', () => {
    expect(openIds([...bash('b1', 'bun run dev --port 5173 # http://localhost:5173'), ...monitor('m1', true)])).toEqual([])
  })

  test("a task's start time is its result line's", () => {
    const scan = newScan()
    foldText(scan, bash('b1').join('\n'))
    expect(scan.open.get('b1')?.startedAt).toBe(Date.parse(at(1)))
  })
})

describe('the reader', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-bg-'))
  })
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('follows a transcript as it grows: a task opens, a line written in two halves counts once whole, its end closes it', async () => {
    const path = join(dir, 'chat.jsonl')
    const live = [{ sessionId: 's1', transcriptPath: path }]
    const reader = createBackgroundTasks()
    writeFileSync(path, `${bash('b1').join('\n')}\n`)
    expect([...((await reader.read(live)).get('s1') ?? [])].map((t) => t.taskId)).toEqual(['b1'])

    const [launch, started] = bash('b2')
    appendFileSync(path, `${launch}\n${started!.slice(0, 40)}`)
    expect((await reader.read(live)).get('s1')?.map((t) => t.taskId)).toEqual(['b1'])
    appendFileSync(path, `${started!.slice(40)}\n`)
    expect((await reader.read(live)).get('s1')?.map((t) => t.taskId)).toEqual(['b1', 'b2'])

    appendFileSync(path, `${notice('b1', '<status>completed</status>')}\n${notice('b2', '<status>completed</status>')}\n`)
    expect((await reader.read(live)).has('s1')).toBe(false)
  })

  test('a transcript rewritten shorter is read afresh, and a session no longer live is dropped', async () => {
    const path = join(dir, 'chat.jsonl')
    const reader = createBackgroundTasks()
    writeFileSync(path, `${[...bash('b1'), ...bash('b2')].join('\n')}\n`)
    expect((await reader.read([{ sessionId: 's1', transcriptPath: path }])).get('s1')?.length).toBe(2)
    writeFileSync(path, `${bash('b3').join('\n')}\n`)
    expect((await reader.read([{ sessionId: 's1', transcriptPath: path }])).get('s1')?.map((t) => t.taskId)).toEqual(['b3'])
    expect((await reader.read([])).size).toBe(0)
  })

  test('the first read starts at the window, past a line it would cut', async () => {
    const path = join(dir, 'chat.jsonl')
    const filler = JSON.stringify({ type: 'assistant', timestamp: at(0), message: { content: 'x'.repeat(2000) } })
    writeFileSync(path, `${[...bash('old'), filler, ...bash('b1')].join('\n')}\n`)
    const reader = createBackgroundTasks({ windowBytes: 1500 })
    expect((await reader.read([{ sessionId: 's1', transcriptPath: path }])).get('s1')?.map((t) => t.taskId)).toEqual(['b1'])
  })
})

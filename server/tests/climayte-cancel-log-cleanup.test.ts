import { afterEach, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { climayteCancel, killsLanded } from '../src/climayte'
import { load, ROOT, save, workers } from '../src/climayte-core'
import type { CliMayteAccount, CliMayteWorker } from '../src/climayte-lib'
import { finishedLines, forgetRead, lastRead } from '../src/climayte-stops'
import { flushCliMayteStore } from '../src/climayte-store-writer'

const made: CliMayteWorker[] = []

afterEach(async () => {
  await killsLanded()
  for (const w of made) {
    for (const at of w.attempts) forgetRead(at.log)
    workers.delete(w.id)
  }
  made.length = 0
  save()
  await flushCliMayteStore()
})

function fixture(failSpend: boolean) {
  load()
  const id = `cancel-log-cleanup-${crypto.randomUUID()}`
  const now = Date.now()
  const failure = new Error('synthetic spend read failed')
  let spendReads = 0
  const account: CliMayteAccount = {
    id: 'cancel-log-cleanup-account',
    num: 1,
    name: 'Example',
    get configDir() {
      if (++spendReads === 1 && failSpend) throw failure
      return join(ROOT, 'synthetic-account')
    },
    sessionPct: 0,
    weekPct: 0,
    planFactor: 1,
  }
  const at: CliMayteWorker['attempts'][number] = {
    account,
    startedAt: now,
    endedAt: null,
    outcome: 'running',
    notice: null,
    resumed: false,
    // No runner: this PID only keeps the pre-stop look from settling the attempt first.
    // killAttempts never kills a bare PID, so no process is launched or killed by this fixture.
    pid: process.pid,
    daemonPid: process.pid,
    sessionId: null,
    log: join(ROOT, 'logs', `${id}.jsonl`),
    errLog: join(ROOT, 'logs', `${id}.err`),
  }
  const w: CliMayteWorker = {
    id,
    group: 'cancel-log-cleanup',
    title: 'Synthetic cancellation',
    cwd: ROOT,
    prompt: 'synthetic task',
    pending: ['synthetic queued message'],
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    accounts: null,
    status: 'running',
    sessionId: null,
    accountId: account.id,
    attempts: [at],
    result: null,
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: now,
    updatedAt: now,
  }
  workers.set(id, w)
  made.push(w)
  const cached = lastRead(at)
  cached.events.push({ type: 'assistant', message: { content: 'synthetic parsed output' } })
  cached.recent.push('synthetic recent summary')
  return { at, w, cached, failure }
}

test('a spend failure still releases the cancelled attempt log and keeps its summaries', () => {
  const { at, w, cached, failure } = fixture(true)
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(climayteCancel({ id: w.id })).toEqual({
      cancelled: [w.id],
      keptMessages: { [w.id]: 1 },
    })
    expect(errors).toHaveBeenCalledWith(
      `[climayte] ${w.id}: its stop could not be recorded in full:`,
      failure,
    )
    expect(w.status).toBe('cancelled')
    expect(w.pending).toEqual(['synthetic queued message'])
    expect(at.outcome).toBe('cancelled')
    expect(at.endedAt).not.toBeNull()
    expect(finishedLines(at.log)).toBe(cached.recent)
    const next = lastRead(at)
    expect(next).not.toBe(cached)
    expect(next.events).toEqual([])
  } finally {
    errors.mockRestore()
  }
})

test('ordinary cancellation still charges the attempt and releases only its parsed log', () => {
  const { at, w, cached } = fixture(false)
  expect(climayteCancel({ id: w.id }).cancelled).toEqual([w.id])
  expect(at.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  expect(w.costUsd).toBe(0)
  expect(finishedLines(at.log)).toBe(cached.recent)
  expect(lastRead(at)).not.toBe(cached)
})

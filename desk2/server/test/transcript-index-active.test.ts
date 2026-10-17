import { expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { buildTranscriptIndex } from '../../shared/transcript-index'

const S = 1000
const H = 3_600_000
const user = (id: string, ts: number, parentToolUseId?: string): TranscriptItem => ({ kind: 'user', id, ts, text: 'example prompt', parentToolUseId })
const text = (id: string, ts: number): TranscriptItem => ({ kind: 'assistant_text', id, ts, text: 'example reply' })
const tool = (id: string, ts: number, endedAt: number): TranscriptItem => ({
  kind: 'tool_use',
  id,
  ts,
  name: 'Bash',
  input: {},
  status: 'done',
  startedAt: ts,
  endedAt
})

test('active time is the turns the session worked, not the seven hours since it began', () => {
  const items: TranscriptItem[] = [
    // A turn: 5 s to think, a 60 s command, 10 s to answer.
    user('u1', 0),
    { kind: 'thinking', id: 'k1', ts: 5 * S, text: 'example thought' },
    tool('t1', 10 * S, 70 * S),
    text('a1', 80 * S),
    // The live checklist is one item stamped at its last change, and a background task's stamp is its own: neither times a turn.
    { kind: 'todos', id: 'todos', ts: 3 * H, todos: [] },
    { kind: 'task', id: 'task-1', ts: 2 * H, taskId: 'task-1', description: 'example task', status: 'completed' },
    // Its notice woke the session two hours later: the wait is left out, the 20 s of work after it counts.
    text('a2', 2 * H + 20 * S),
    tool('t2', 2 * H + 30 * S, 2 * H + 40 * S),
    // The person's next prompt, three hours on: a sub-agent's prompt inside the turn is work, not a new turn.
    user('u2', 5 * H),
    user('sub', 5 * H + 10 * S, 't-agent'),
    text('a3', 5 * H + 30 * S),
    // A Desk chat's turn closed by its engine: its result's own duration, not the 2 s its items span.
    user('u3', 6 * H),
    text('a4', 6 * H + 1 * S),
    { kind: 'result', id: 'r1', ts: 6 * H + 2 * S, ok: true, durationMs: 90 * S, costUsd: 0, turns: 1 },
    // A ping another program typed in starts a turn too.
    { kind: 'note', id: 'n1', ts: 7 * H, from: 'AgentHydra · CliMayte', text: 'example ping' },
    text('a5', 7 * H + 15 * S)
  ]
  expect(buildTranscriptIndex(items).activeMs).toBe((80 + 20 + 30 + 90 + 15) * S)
})

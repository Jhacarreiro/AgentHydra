// When CliMayte asks a session to hand off for its conversation's size (climayte-lib.ts).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  contextTokens,
  continuationPrompt,
  notConverging,
  pickAccount,
  transcriptHandoff,
  windDownAt,
  windDownMessage,
} from '../src/climayte-lib'
import { withStops } from '../src/climayte-stops'

describe('continuationPrompt', () => {
  const args = ['the task', 'the handoff', 'h.md', ['t.jsonl'], []] as [
    string,
    string,
    string,
    string[],
    string[],
  ]
  const from = { sameAccount: true, why: 'context' as const }
  test('a chat heir is the main agent; any other continuation is unchanged', () => {
    const chat = continuationPrompt(...args, { ...from, chat: true })
    expect(chat).toContain("main agent of the owner's Desk chat")
    expect(chat).toContain('he reads every reply')
    expect(chat).toContain('commit with that message verbatim')
    const plain = continuationPrompt(...args, from)
    expect(plain).not.toContain('main agent')
    expect(plain).toContain(
      'An earlier session already worked on this task on this account and handed off because its conversation had grown large. Continue from its handoff below',
    )
  })
})

const now = Date.now()
const reading = (sessionPct: number) => ({
  sessionPct,
  sessionResetsAt: now + 3_600_000,
  weekPct: 10,
  weekResetsAt: null,
  overageAllowed: false,
  at: now - 5_000,
})

describe('a handoff on conversation size', () => {
  test('an account with room hands off once the conversation passes the line, not before', () => {
    // The line is 200k: below it a fresh session's cold start costs more than its smaller reads save.
    expect(windDownAt(reading(10), null, now, 210_000)).toEqual({
      reason: 'context',
      tokens: 210_000,
    })
    expect(windDownAt(reading(10), null, now, 160_000)).toBeNull()
    expect(windDownAt(reading(10), null, now, null)).toBeNull()
    // At its stop line the account is the reason: the next session must start somewhere else.
    expect(windDownAt(reading(85), null, now, 210_000)).toMatchObject({ reason: 'usage', pct: 85 })
  })

  test("the size is the newest main-agent request's, never a subagent's", () => {
    const request = (read: number, parent: string | null = null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 900,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: 2_000,
        },
      },
    })
    const events = [
      request(90_000),
      request(149_000),
      { type: 'user', message: { content: [] } },
      request(12_000, 'toolu_sub'),
    ]
    // 10 input + 149,000 read + 2,000 written; the output is not part of what it read.
    expect(contextTokens(events)).toBe(151_010)
    expect(contextTokens([{ type: 'system', subtype: 'init' }])).toBeNull()
  })

  test('does not count towards the handoff cap that stops a task going in circles', () => {
    // A long task hands off every 200k: three of those are the plan, not a failure to converge.
    const at = (windDown: { reason?: 'context' }) =>
      ({ account: { id: 'a', num: 1, name: 'a' }, outcome: 'handoff', windDown }) as any
    const w = (attempts: unknown[]) =>
      ({ attempts, model: 'claude-opus-5-5', size: { expected: 10 } }) as any
    const context = { reason: 'context' as const }
    expect(notConverging(w([at(context), at(context), at(context)]))).toBeNull()
    expect(notConverging(w([at(context), at({}), at({}), at({})]))).toMatch(/3 handoffs/)
  })

  test('its next session may start on another account without counting as a move', () => {
    const at = (id: string, outcome: string, windDown?: { reason?: 'context' }) =>
      ({ account: { id, num: 1, name: id }, outcome, windDown }) as any
    const w = (attempts: unknown[]) =>
      ({ attempts, model: 'claude-opus-5-5', size: { expected: 10 } }) as any
    const context = { reason: 'context' as const }
    // Four account changes, each a fresh session after a size handoff: the task is converging.
    const long = ['a', 'b', 'a', 'b', 'a'].map((id) => at(id, 'handoff', context))
    expect(notConverging(w(long))).toBeNull()
    // The same four changes after a limit are the five-minute rule moving it (owner, 2026-10-03), not
    // a move that counts; after a transient failure they are a task bouncing between accounts.
    const limits = ['a', 'b', 'a', 'b', 'a'].map((id) => at(id, 'quota'))
    expect(notConverging(w(limits))).toBeNull()
    const bouncing = ['a', 'b', 'a', 'b', 'a'].map((id) => at(id, 'transient'))
    expect(notConverging(w(bouncing))).toMatch(/4 moves/)
  })

  test('its next session is not pushed off the account it left', () => {
    const acct = (id: string, num: number, sessionPct: number) => ({
      id,
      num,
      name: id,
      configDir: id,
      sessionPct,
      weekPct: 10,
    })
    const accounts = [acct('a', 1, 30), acct('b', 2, 60)]
    const after = (windDown: { reason?: 'context' }) =>
      ({
        accounts: null,
        accountId: 'a',
        attempts: [{ account: { id: 'a', num: 1, name: 'a' }, outcome: 'handoff', windDown }],
      }) as any
    // The account's usage did not ask for it, so the account with the most room is still 'a'.
    expect(pickAccount(after({ reason: 'context' }), accounts, {}, new Map(), 2, now)?.id).toBe('a')
    // A handoff for the account's usage still starts the next session somewhere else.
    expect(pickAccount(after({}), accounts, {}, new Map(), 2, now)?.id).toBe('b')
  })
})

describe('a chat worker winds down silently', () => {
  const ask = (chat: boolean) =>
    windDownMessage({ reason: 'context', tokens: 210_000 }, 'h.md', chat)

  test('the chat ask never tells the owner the handoff is written', () => {
    const text = ask(true)
    expect(text).toContain('Do not mention the handoff')
    expect(text).not.toContain('end your turn with one line saying the handoff is written')
  })

  test('a non-chat ask keeps its one-line report', () => {
    expect(ask(false)).toContain('end your turn with one line saying the handoff is written')
  })

  test('a chat whose handoff was written ends done, not handoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'climayte-handoff-'))
    const path = join(dir, 'h.md')
    const at = Date.now()
    writeFileSync(path, 'handoff')
    const attempt = { windDown: { at, pct: null, path, reason: 'context' } } as any
    const verdict = { outcome: 'done', notice: null } as any
    expect(withStops(attempt, verdict, true).outcome).toBe('done')
    expect(withStops(attempt, verdict, false).outcome).toBe('handoff')
  })
})

describe('the continuation wording Desk 2 parses', () => {
  test('a continuation still says it continues from the handoff', () => {
    const text = continuationPrompt('the task', 'the handoff', 'h.md', [], [], {
      sameAccount: true,
      why: 'context',
    })
    expect(text).toMatch(
      /An earlier session already worked on this task on this account and handed off because its conversation had grown large\. Continue from its handoff below/,
    )
  })
})

describe('a handoff the daemon writes from the transcript', () => {
  const line = (ev: unknown) => JSON.stringify(ev)
  const transcript = [
    line({ type: 'user', message: { content: 'Owner: first ask about the sample page' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reply one.' }] } }),
    line({
      type: 'assistant',
      parent_tool_use_id: 'x',
      message: { content: [{ type: 'text', text: 'sub-agent noise' }] },
    }),
    line({ type: 'user', message: { content: 'second ask about the cart' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reply two.' }] } }),
  ].join('\n')

  test('keeps the owner messages and the agent replies, newest last, without sub-agent text', () => {
    const out = transcriptHandoff(transcript)
    expect(out).toContain('Owner: first ask about the sample page')
    expect(out).toContain('Agent: Reply one.')
    expect(out).toContain('Owner: second ask about the cart')
    expect(out).toContain('Agent: Reply two.')
    expect(out).not.toContain('sub-agent noise')
    expect(out.indexOf('Reply one.')).toBeLessThan(out.indexOf('second ask'))
  })

  test('stays within the cap', () => {
    const big = line({ type: 'user', message: { content: 'x'.repeat(3_000) } })
    const out = transcriptHandoff([big, big, big].join('\n'), 4_000)
    expect(out.length).toBeLessThanOrEqual(4_000)
  })

  test('an empty transcript says so', () => {
    expect(transcriptHandoff('')).toBe('(The transcript held no messages to carry over.)')
  })
})

describe('the w-984f4bed sequence (invented text)', () => {
  test('a chat turn that hit the size line, wrote its handoff silently, and ends done', () => {
    const dir = mkdtempSync(join(tmpdir(), 'climayte-chat-'))
    const path = join(dir, 'w-984f4bed-4-wind.md')
    const at = Date.now()
    // The session was asked to wind down during a short turn and wrote the handoff in that turn.
    writeFileSync(path, 'Done: sample page layout. Next: the cart total.')
    const attempt = { windDown: { at, pct: null, path, reason: 'context' } } as any
    const verdict = { outcome: 'done', notice: null, reply: 'Here is the sample page.' } as any
    const out = withStops(attempt, verdict, true)
    expect(out.outcome).toBe('done')
    expect(windDownMessage({ reason: 'context', tokens: 210_000 }, path, true)).not.toContain(
      'one line saying the handoff',
    )
  })
})

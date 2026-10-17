import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTurnCount, codexTurnOpen, findCodexRollout, lastCodexContext, TURN_TAIL_BYTES } from '../../src/bridge/codex-rollout'

const temps: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'desk-rollout-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const count = (info: object | null) => JSON.stringify({ timestamp: '2019-10-23T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info } })
const usage = (total: number) => ({ input_tokens: total - 40, cached_input_tokens: total - 2000, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: total })

describe('a Codex chat rollout', () => {
  test('is found by its thread id under any home, archived too, and an id that could name a path is refused', async () => {
    const a = temp()
    const b = temp()
    const day = join(b, 'sessions', '2019', '10', '23')
    mkdirSync(day, { recursive: true })
    mkdirSync(join(a, 'sessions', '2019', '10', '22'), { recursive: true })
    writeFileSync(join(day, `rollout-2019-10-23T09-00-00-${THREAD}.jsonl`), '')
    writeFileSync(join(day, 'rollout-2019-10-23T09-30-00-0199a1b2-0000-7e5f-8a9b-0c1d2e3f4a5b.jsonl'), '')
    expect(await findCodexRollout(THREAD, [a, b])).toBe(join(day, `rollout-2019-10-23T09-00-00-${THREAD}.jsonl`))
    expect(await findCodexRollout('0199a1b2-ffff-7e5f-8a9b-0c1d2e3f4a5b', [a, b])).toBeNull()
    expect(await findCodexRollout('../sessions', [a, b])).toBeNull()
    // An archived thread's file moves to archived_sessions/, flat.
    const archivedId = '0199a1b2-aaaa-7e5f-8a9b-0c1d2e3f4a5b'
    mkdirSync(join(a, 'archived_sessions'))
    writeFileSync(join(a, 'archived_sessions', `rollout-2019-10-22T07-21-12-${archivedId}.jsonl`), '')
    expect(await findCodexRollout(archivedId, [a, b])).toBe(join(a, 'archived_sessions', `rollout-2019-10-22T07-21-12-${archivedId}.jsonl`))
  })

  test("its context is the last turn's tokens and the model's window; an event with no info is skipped", () => {
    const f = join(temp(), 'rollout.jsonl')
    writeFileSync(f, [count(null), count({ last_token_usage: usage(30_000), total_token_usage: usage(30_000), model_context_window: 258_400 }), count({ last_token_usage: usage(51_018), total_token_usage: usage(81_018), model_context_window: 258_400 }), count(null)].join('\n'))
    expect(lastCodexContext(f)).toEqual({ tokens: 51_018, window: 258_400, total: 81_018 })
    writeFileSync(f, count({ last_token_usage: usage(9_000), total_token_usage: usage(9_000) }))
    expect(lastCodexContext(f)).toEqual({ tokens: 9_000, window: null, total: 9_000 })
    writeFileSync(f, count(null))
    expect(lastCodexContext(f)).toBeNull()
  })

  test('its last turn is open from task_started until task_complete or turn_aborted; a tail of turn output with no mark is open', () => {
    const f = join(temp(), 'rollout.jsonl')
    const mark = (type: string) => JSON.stringify({ timestamp: '2019-10-23T10:00:00Z', type: 'event_msg', payload: { type } })
    const item = JSON.stringify({ timestamp: '2019-10-23T10:00:01Z', type: 'response_item', payload: { type: 'function_call_output', output: 'x' } })
    const open = (...lines: string[]) => (writeFileSync(f, lines.join('\n') + '\n'), codexTurnOpen(f))
    expect(open(mark('task_started'), item, count(null), item)).toBe(true)
    expect(open(mark('task_started'), item, mark('task_complete'))).toBe(false)
    expect(open(mark('task_complete'), mark('task_started'), item)).toBe(true)
    expect(open(mark('task_started'), item, mark('turn_aborted'))).toBe(false)
    // An event whose own type is another, with a mark's type nested in it, is not a mark.
    expect(open(mark('task_complete'), JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'task_started' } } }))).toBe(false)
    expect(open(item)).toBe(false)
    expect(open(mark('task_complete'), ...Array.from({ length: Math.ceil(TURN_TAIL_BYTES / item.length) + 10 }, () => item))).toBe(true)
  })

  test('its turns are its task_started marks over the whole file, counted again only where the file grew', async () => {
    const f = join(temp(), 'rollout.jsonl')
    const mark = (type: string) => JSON.stringify({ timestamp: '2019-10-23T10:00:00Z', type: 'event_msg', payload: { type } })
    // A message that mentions the mark, and an event nesting its type, are not turns.
    const said = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '{"payload":{"type":"task_started"}}' }] } })
    const nested = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'task_started' } } })
    const turn = [mark('task_started'), said, nested, count(null), mark('task_complete')].join('\n') + '\n'
    writeFileSync(f, turn.repeat(3))
    expect(await codexTurnCount(f)).toBe(3)
    // Codex appends while Desk reads: a count taken with a mark half written finds it once the rest is there.
    const next = mark('task_started')
    const cut = next.indexOf('task_started')
    appendFileSync(f, next.slice(0, cut))
    expect(await codexTurnCount(f)).toBe(3)
    appendFileSync(f, next.slice(cut) + '\n' + turn)
    expect(await codexTurnCount(f)).toBe(5)
    expect(await codexTurnCount(f)).toBe(5)
    // A file that shrank was replaced: counted from its start.
    writeFileSync(f, turn)
    expect(await codexTurnCount(f)).toBe(1)
  })
})

// server/tests/sessions-fold-carry.test.ts — a transcript past the 12 MB read window keeps its
// whole-history message count across a daemon restart (finding c22). The fold state lives in memory,
// so a restart used to rebuild it from the last 12 MB alone and message_count dropped to the
// window's share (measured: 10,404 real messages shown as 1,855). The scan row now records where
// its fold stopped, and a fresh window fold carries the row's count on when the file only grew.
// A rewrite or a shrink must not carry, and a file inside the window is untouched.
//
// "Restart" is resetFoldStatesForTests(): the in-memory fold states go, the suite's scratch sqlite
// (the persisted scan rows) stays, exactly what a new daemon process sees. Every "fresh" comparison
// scans the same path under another session id, so it has neither fold state nor a row.
import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFoldStatesForTests, scanMeta } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

type ScannedMeta = NonNullable<Awaited<ReturnType<typeof scanMeta>>>

const WINDOW = 12 * 1024 * 1024

/** Message `i` as one JSONL line. Every line is the same length, so a window that slides by k
 *  appended lines loses exactly k lines off its front. */
function line(i: number, filler = 'x'): string {
  const role = i % 2 === 0 ? 'user' : 'assistant'
  const text = `m${String(i).padStart(6, '0')} ${filler.repeat(1000)}`
  const timestamp = `2024-09-28T12:${String(i % 60).padStart(2, '0')}:00Z`
  return `${JSON.stringify({ type: role, message: { role, content: text }, timestamp })}\n`
}
const lines = (from: number, to: number, filler = 'x') => {
  let out = ''
  for (let i = from; i < to; i++) out += line(i, filler)
  return out
}

// Just over the window: the first parse already reads only part of the file.
const BIG = Math.ceil((WINDOW + 256 * 1024) / line(0).length)

const FIELDS = [
  'title',
  'created_at',
  'last_activity_at',
  'last_role',
  'last_text_preview',
  'substantive_turns',
  'thread_key',
  'ended_because',
  'limit_stop',
] as const
const pick = (m: ScannedMeta | null) =>
  m ? Object.fromEntries(FIELDS.map((f) => [f, m[f]])) : null

function scratch(run: (path: string, tf: (id: string) => TranscriptFile) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-fold-carry-'))
    const path = join(dir, 'long.jsonl')
    const tf = (id: string): TranscriptFile => {
      const s = statSync(path)
      return {
        session_id: id,
        source: 'claude',
        path,
        project: 'C--Users-me-fold-carry',
        mtime_ms: s.mtimeMs,
        size_bytes: s.size,
        archived: false,
      }
    }
    try {
      await run(path, tf)
    } finally {
      resetFoldStatesForTests()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test(
  'past the window, a restart carries the count on and only appended messages add to it',
  scratch(async (path, tf) => {
    writeFileSync(path, lines(0, BIG))
    const first = (await scanMeta(tf('carry')))!.message_count
    // First seen past 12 MB: the window is all it ever read, so it counts from there.
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(BIG)

    resetFoldStatesForTests()
    appendFileSync(path, lines(BIG, BIG + 3))
    const carried = await scanMeta(tf('carry'))
    expect(carried?.message_count).toBe(first + 3)
    // Every other field is the new window's, exactly as a fresh parse of it gives.
    expect(pick(carried)).toEqual(pick(await scanMeta(tf('carry-fresh-1'))))

    // From there the in-memory state increments as before.
    appendFileSync(path, lines(BIG + 3, BIG + 5))
    expect((await scanMeta(tf('carry')))?.message_count).toBe(first + 5)

    // And the carried count is what the row keeps, so a second restart carries it again.
    resetFoldStatesForTests()
    appendFileSync(path, lines(BIG + 5, BIG + 6))
    const again = await scanMeta(tf('carry'))
    expect(again?.message_count).toBe(first + 6)
    expect(pick(again)).toEqual(pick(await scanMeta(tf('carry-fresh-2'))))
  }),
  120_000,
)

test(
  'a rewrite before the old stop point falls back to the window count',
  scratch(async (path, tf) => {
    writeFileSync(path, lines(0, BIG))
    const first = (await scanMeta(tf('rewrite')))!.message_count

    resetFoldStatesForTests()
    // Same length, different last record: the bytes ending at the old stop point changed.
    writeFileSync(path, lines(0, BIG - 1) + line(BIG - 1, 'y') + lines(BIG, BIG + 3))
    const after = await scanMeta(tf('rewrite'))
    const fresh = await scanMeta(tf('rewrite-fresh'))
    expect(after?.message_count).toBe(fresh!.message_count)
    expect(after?.message_count).not.toBe(first + 3)
  }),
  120_000,
)

test(
  'a file that shrank falls back to the window count',
  scratch(async (path, tf) => {
    writeFileSync(path, lines(0, BIG))
    await scanMeta(tf('shrink'))

    resetFoldStatesForTests()
    writeFileSync(path, lines(0, BIG - 5))
    expect(statSync(path).size).toBeGreaterThan(WINDOW)
    const after = await scanMeta(tf('shrink'))
    expect(after?.message_count).toBe((await scanMeta(tf('shrink-fresh')))!.message_count)
  }),
  120_000,
)

test(
  'a file inside the window counts every message, restart or not',
  scratch(async (path, tf) => {
    writeFileSync(path, lines(0, 10))
    expect((await scanMeta(tf('small')))?.message_count).toBe(10)

    resetFoldStatesForTests()
    appendFileSync(path, lines(10, 13))
    const after = await scanMeta(tf('small'))
    expect(after?.message_count).toBe(13)
    expect(after?.message_count).toBe((await scanMeta(tf('small-fresh')))?.message_count)
  }),
)

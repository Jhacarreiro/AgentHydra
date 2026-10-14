// GET /api/external/sessions/:id/older?limit pages an outside session's history; without limit it answers whole.
import { expect, test } from 'bun:test'
import { OLDER_BEFORE_HEADER, OLDER_END_HEADER, type TranscriptItem } from '@shared/protocol'
import { TAIL_BYTES } from '../src/bridge/session-jsonl'
import { FILLER, SESSION, bootWithSession, userLine } from './external-fixture'

test('older pages down to the first item with no gap or duplicate; without limit it is unchanged', async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => userLine(i, `m${i} ${FILLER}`))
  expect(JSON.stringify(lines).length).toBeGreaterThan(TAIL_BYTES)
  const desk = await bootWithSession(lines)
  const base = `${desk.url}/api/external/sessions/${SESSION}`
  const head = await fetch(`${base}/items`)
  const newest = (await head.json()) as TranscriptItem[]
  const before = Number(head.headers.get(OLDER_BEFORE_HEADER))
  expect(before).toBeGreaterThan(0)

  const whole = (await (await fetch(`${base}/older?before=${before}`)).json()) as TranscriptItem[]
  expect(whole.length + newest.length).toBe(3000)

  const pages: TranscriptItem[][] = []
  let end: string | null = null
  for (let n = 0; n < 100; n++) {
    const res: Response = await fetch(`${base}/older?before=${before}&limit=250${end === null ? '' : `&end=${end}`}`)
    const page = (await res.json()) as TranscriptItem[]
    expect(page.length).toBeLessThanOrEqual(250)
    pages.unshift(page)
    end = res.headers.get(OLDER_END_HEADER)
    if (end === '0') break
  }
  const joined = pages.flat()
  expect(joined.map((i) => i.id)).toEqual(whole.map((i) => i.id))
  expect(joined[0]!.id).toBe('u0')
  expect(new Set(joined.map((i) => i.id)).size).toBe(joined.length)
})

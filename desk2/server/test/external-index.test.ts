// GET /api/external/sessions/:id/index and /items/:itemId.
import { expect, test } from 'bun:test'
import type { TranscriptIndex, TranscriptItem } from '@shared/protocol'
import { FILLER, SESSION, bootWithSession, userLine } from './external-fixture'

const at = (n: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, 0) + n * 1000).toISOString()

test('the index lists user messages, and a running task older than the newest 200 items', async () => {
  const lines: object[] = [userLine(0, '\n  first ask\nsecond line')]
  lines.push({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'bun run dev', run_in_background: true } }] } })
  lines.push({ type: 'user', uuid: 'r1', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: bg1' }] } })
  for (let i = 2; i < 2200; i++) lines.push(userLine(i, `m${i} ${FILLER}`))
  const desk = await bootWithSession(lines)
  const base = `${desk.url}/api/external/sessions/${SESSION}`
  const newest = (await (await fetch(`${base}/items`)).json()) as TranscriptItem[]
  const index = (await (await fetch(`${base}/index`)).json()) as TranscriptIndex
  const users = index.userMessages
  expect(index.total).toBeGreaterThan(newest.length)
  expect(users[0]).toMatchObject({ id: 'u0', position: 0, firstLine: 'first ask', images: 0 })
  expect(users.at(-1)!.firstLine.startsWith('m2199')).toBe(true)
  expect(index.lastUserText.startsWith('m2199')).toBe(true)
  expect(index.latestTodos).toBeNull()
  const one = (await (await fetch(`${base}/items/${users[3]!.id}`)).json()) as TranscriptItem
  expect(one.id).toBe(users[3]!.id)
  expect(index.runningTasks.map((t) => (t as { taskId: string }).taskId)).toEqual(['bg1'])
  expect((await fetch(`${base}/items/nope`)).status).toBe(404)
})

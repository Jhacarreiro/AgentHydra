// server/tests/climayte-request-id.test.ts — a request sent again is taken once. Hydra Desk gave up on
// POST /api/corch/workers after 4 s while AgentHydra was busy (2026-10-13), said the message was not sent,
// and the owner sent it again: AgentHydra had started the first worker anyway, so two ran the same
// message. Desk now names each start and each message with a requestId and retries with the same one.

import { afterAll, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteList,
  climayteRun,
  climayteSend,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { workers } from '../src/climayte-core'

describe('a start or a message sent again with its requestId is taken once', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ah-climayte-request-id-'))
  const groups = new Set<string>()
  afterAll(() => {
    for (const group of groups) climayteCancel({ group })
    setCliMayteAccountsProvider(null)
    rmSync(cwd, { recursive: true, force: true })
  })
  const chat = (prompt: string, requestId?: string) => ({
    prompt,
    cwd,
    title: prompt,
    chat: true,
    ...(requestId ? { requestId } : {}),
  })

  test('a chat start sent again answers the worker it made, even with copies', () => {
    setCliMayteAccountsProvider(() => [])
    const first = climayteRun({
      group: 'request-id-start',
      tasks: [chat('hello there', 'desk-sent:1:a')],
      copies: true,
    })
    groups.add(first.group)
    const again = climayteRun({
      group: 'request-id-start',
      tasks: [chat('hello there', 'desk-sent:1:a')],
      copies: true,
    })
    expect(again.workers.map((w) => [w.id, w.repeat])).toEqual([[first.workers[0]?.id, true]])
    expect(climayteList({ group: 'request-id-start' })).toHaveLength(1)
    // The id is the request, not the words: another id with the same words is a new chat.
    const other = climayteRun({
      group: 'request-id-start',
      tasks: [chat('hello there', 'desk-sent:2:b')],
      copies: true,
    })
    expect(other.workers[0]?.repeat).toBeUndefined()
    expect(other.workers[0]?.id).not.toBe(first.workers[0]?.id)
    expect(climayteList({ group: 'request-id-start' })).toHaveLength(2)
  })

  test('an unnamed dispatch sent again answers in its workers group, so status and cancel reach them', () => {
    setCliMayteAccountsProvider(() => [])
    const first = climayteRun({ tasks: [chat('unnamed A', 'unnamed-run:1')] })
    groups.add(first.group)
    // The same request with no group answers its worker, in the group that holds it (not a new g- name).
    const again = climayteRun({ tasks: [chat('unnamed A', 'unnamed-run:1')] })
    expect(again.group).toBe(first.group)
    expect(again.workers.map((w) => [w.id, w.repeat])).toEqual([[first.workers[0]?.id, true]])
    // A retry that adds a task joins the same group, and the group lists both workers.
    const grown = climayteRun({
      tasks: [chat('unnamed A', 'unnamed-run:1'), chat('unnamed B', 'unnamed-run:2')],
    })
    expect(grown.group).toBe(first.group)
    expect(climayteList({ group: first.group })).toHaveLength(2)
    // A request id nothing made yet still gets a group of its own.
    const unseen = climayteRun({ tasks: [chat('unnamed C', 'unnamed-run:3')] })
    groups.add(unseen.group)
    expect(unseen.group).not.toBe(first.group)
    // Cancelling the group reaches both workers the retry named.
    const cancelled = climayteCancel({ group: first.group })
    expect(cancelled.cancelled.sort()).toEqual([first.workers[0]?.id, grown.workers[1]?.id].sort())
  })

  test('still the same worker once it was cancelled: the request made it, so a retry never makes a second', () => {
    setCliMayteAccountsProvider(() => [])
    const first = climayteRun({
      group: 'request-id-cancelled',
      tasks: [chat('stop me', 'desk-sent:3:c')],
      copies: true,
    })
    groups.add(first.group)
    climayteCancel({ group: 'request-id-cancelled' })
    const again = climayteRun({
      group: 'request-id-cancelled',
      tasks: [chat('stop me', 'desk-sent:3:c')],
      copies: true,
    })
    expect(again.workers[0]?.id).toBe(first.workers[0]?.id)
    expect(climayteList({ group: 'request-id-cancelled' })).toHaveLength(1)
  })

  test('a message sent again is queued once, and its id stays off the worker views', () => {
    setCliMayteAccountsProvider(() => [])
    const run = climayteRun({
      group: 'request-id-send',
      tasks: [chat('first message', 'desk-sent:4:d')],
    })
    groups.add(run.group)
    const id = run.workers[0]?.id as string
    const sent = climayteSend(id, 'a follow-up', { requestId: 'desk-sent:5:e' })
    const again = climayteSend(id, 'a follow-up', { requestId: 'desk-sent:5:e' })
    expect(sent.ok).toBe(true)
    expect(again).toMatchObject({ ok: true, message: expect.stringContaining('Already taken') })
    expect(workers.get(id)?.pending).toEqual(['a follow-up'])
    // The same words under a new id are a new message (the owner typed them twice).
    expect(climayteSend(id, 'a follow-up', { requestId: 'desk-sent:6:f' }).ok).toBe(true)
    expect(workers.get(id)?.pending).toEqual(['a follow-up', 'a follow-up'])
    expect(climayteList({ id })[0]?.sendIds).toBeUndefined()
    expect(climayteList({ id })[0]?.requestId).toBe('desk-sent:4:d')
  })

  test('a message id is kept ten minutes however many other messages come, then forgotten', () => {
    setCliMayteAccountsProvider(() => [])
    const run = climayteRun({ group: 'request-id-window', tasks: [chat('busy worker')] })
    groups.add(run.group)
    const id = run.workers[0]?.id as string
    const t0 = Date.now()
    setSystemTime(new Date(t0))
    try {
      expect(climayteSend(id, 'the slow one', { requestId: 'desk-sent:10:slow' }).ok).toBe(true)
      // Kept by count (the 50 newest), the slow retry below was queued a second time.
      for (let i = 0; i < 60; i++)
        expect(climayteSend(id, `other ${i}`, { requestId: `desk-sent:other:${i}` }).ok).toBe(true)
      setSystemTime(new Date(t0 + 9 * 60_000))
      expect(climayteSend(id, 'the slow one', { requestId: 'desk-sent:10:slow' })).toMatchObject({
        ok: true,
        message: expect.stringContaining('Already taken'),
      })
      expect(workers.get(id)?.pending.filter((p) => p === 'the slow one')).toHaveLength(1)
      // Past the window the id is a new message again, and the expired ids are dropped.
      setSystemTime(new Date(t0 + 11 * 60_000))
      const late = climayteSend(id, 'the slow one', { requestId: 'desk-sent:10:slow' })
      expect(late.ok).toBe(true)
      expect(late.message).not.toContain('Already taken')
      expect(workers.get(id)?.pending.filter((p) => p === 'the slow one')).toHaveLength(2)
      expect(workers.get(id)?.sendIds).toEqual([{ id: 'desk-sent:10:slow', at: t0 + 11 * 60_000 }])
    } finally {
      setSystemTime()
    }
  })

  test('ids saved before they carried their time still answer a retry', () => {
    setCliMayteAccountsProvider(() => [])
    const run = climayteRun({ group: 'request-id-old-shape', tasks: [chat('saved before')] })
    groups.add(run.group)
    const id = run.workers[0]?.id as string
    const w = workers.get(id)
    if (!w) throw new Error('no worker')
    w.sendIds = ['desk-sent:20:old']
    expect(climayteSend(id, 'from before', { requestId: 'desk-sent:20:old' })).toMatchObject({
      ok: true,
      message: expect.stringContaining('Already taken'),
    })
    expect(climayteSend(id, 'a new one', { requestId: 'desk-sent:21:new' }).ok).toBe(true)
    expect(w.sendIds?.map((s) => (typeof s === 'string' ? s : s.id))).toEqual([
      'desk-sent:20:old',
      'desk-sent:21:new',
    ])
    expect(w.pending).toEqual(['a new one'])
  })

  test('a request id that is not one is refused, and nothing is made or queued', () => {
    setCliMayteAccountsProvider(() => [])
    expect(() =>
      climayteRun({ group: 'request-id-bad', tasks: [{ ...chat('x'), requestId: '' }] }),
    ).toThrow(/requestId/)
    expect(() =>
      climayteRun({
        group: 'request-id-bad',
        tasks: [{ ...chat('x'), requestId: 'r'.repeat(201) }],
      }),
    ).toThrow(/requestId/)
    // Hydra Desk's probe (takesRequestIds): a task with nothing but an empty requestId is refused for its
    // requestId, not its empty prompt, so Desk can tell this AgentHydra from one that ignores the field.
    expect(() => climayteRun({ tasks: [{ prompt: '', cwd: '', requestId: '' }] })).toThrow(
      /requestId/,
    )
    expect(climayteList({ group: 'request-id-bad' })).toHaveLength(0)
    const run = climayteRun({ group: 'request-id-bad-send', tasks: [chat('first')] })
    groups.add(run.group)
    const id = run.workers[0]?.id as string
    expect(climayteSend(id, 'next', { requestId: 7 as unknown as string })).toMatchObject({
      ok: false,
      message: expect.stringContaining('requestId'),
    })
    expect(workers.get(id)?.pending).toEqual([])
  })
})

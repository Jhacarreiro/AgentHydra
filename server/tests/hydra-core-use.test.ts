import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { emptyDoc, renderHydra } from '../src/hydra-core/hydra-md'
import { chatPaths } from '../src/hydra-core/paths'
import { type Daemon, defaultDaemon, use } from '../src/hydra-core/use'
import { scratch } from './hydra-core-fixture'

let dir = ''
const chat = 'chat-example-use'
const now = new Date('2026-10-13T10:00:00.000Z')

beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeDaemon(report: { status: string; text: string | null } | null) {
  const calls = {
    dispatch: [] as { prompt: string; title: string }[],
    report: [] as { id: string; waitS: number }[],
  }
  const daemon: Daemon = {
    async dispatch(prompt, title) {
      calls.dispatch.push({ prompt, title })
      return 'job-1'
    },
    async report(id, waitS) {
      calls.report.push({ id, waitS })
      return report
    },
  }
  return { daemon, calls }
}

function writeDoc(): void {
  const files = chatPaths(dir, chat)
  mkdirSync(files.root, { recursive: true })
  writeFileSync(files.hydraMd, renderHydra(emptyDoc(new Date(0))))
}

test('become writes the lead line and creates hydra.md when it is missing', async () => {
  const { daemon } = fakeDaemon(null)
  const r = await use(dir, { chat, id: 'person:iris-ui', mode: 'become' }, daemon, now)
  expect(r).toMatchObject({ text: 'Iris Example: full persona text.\n' })
  const md = readFileSync(chatPaths(dir, chat).hydraMd, 'utf8')
  expect(md).toContain('## Lead (become)\nIris Example - UI designer. Full text: ')
})

test('become refuses an entry that is not a person', async () => {
  const { daemon } = fakeDaemon(null)
  await expect(
    use(dir, { chat, id: 'instrument:screen-capture', mode: 'become' }, daemon, now),
  ).rejects.toThrow('is not a person')
})

test('a person refuses a mode it does not allow', async () => {
  const { daemon } = fakeDaemon(null)
  await expect(
    use(dir, { chat, id: 'person:ops-lead', mode: 'consult', question: 'q' }, daemon, now),
  ).rejects.toThrow('does not allow mode consult')
})

test('hire records the line under you and returns the persona path with a prefix', async () => {
  writeDoc()
  const { daemon } = fakeDaemon(null)
  const r = await use(dir, { chat, id: 'person:iris-ui', mode: 'hire' }, daemon, now)
  expect(r).toMatchObject({ id: 'person:iris-ui', persona: expect.any(String) })
  expect(String((r as { prefix: string }).prefix)).toContain('Iris Example')
  expect(readFileSync(chatPaths(dir, chat).hydraMd, 'utf8')).toContain(
    '## Under you\n- hire person:iris-ui - ',
  )
})

test('consult dispatches a review worker, waits 30 s and returns the report text', async () => {
  writeDoc()
  const { daemon, calls } = fakeDaemon({ status: 'done', text: 'Sketch A' })
  const r = await use(
    dir,
    { chat, id: 'person:iris-ui', mode: 'consult', question: 'Is the grid right?' },
    daemon,
    now,
  )
  expect(r).toEqual({ job: 'job-1', status: 'done', text: 'Sketch A' })
  expect(calls.dispatch[0]?.prompt).toContain('Question:\nIs the grid right?')
  expect(calls.report).toEqual([{ id: 'job-1', waitS: 30 }])
  expect(readFileSync(chatPaths(dir, chat).hydraMd, 'utf8')).toContain(
    '## Under you\n- consult person:iris-ui - ',
  )
})

test('consult with a job that is still running returns working and does not dispatch again', async () => {
  const { daemon, calls } = fakeDaemon(null)
  const r = await use(
    dir,
    { chat, id: 'person:iris-ui', mode: 'consult', job: 'job-7' },
    daemon,
    now,
  )
  expect(r).toEqual({ job: 'job-7', status: 'working' })
  expect(calls.dispatch).toEqual([])
  expect(calls.report).toEqual([{ id: 'job-7', waitS: 30 }])
})

test('consult without a question or a job is refused', async () => {
  const { daemon } = fakeDaemon(null)
  await expect(
    use(dir, { chat, id: 'person:iris-ui', mode: 'consult' }, daemon, now),
  ).rejects.toThrow('consult needs a question')
})

test('load returns the text of a non-person entry and refuses a person', async () => {
  const { daemon } = fakeDaemon(null)
  expect(
    await use(dir, { chat, id: 'instrument:screen-capture', mode: 'load' }, daemon, now),
  ).toEqual({
    id: 'instrument:screen-capture',
    text: 'Run: capture --url <url>',
  })
  await expect(use(dir, { chat, id: 'person:iris-ui', mode: 'load' }, daemon, now)).rejects.toThrow(
    'use become, consult or hire',
  )
})

test('the daemon client reads the report view, which the daemon answers as a bare list', async () => {
  const seen: string[] = []
  const api = async (path: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${path}`)
    if (init?.method === 'POST') return { workers: [{ id: 'w-1' }] }
    return [{ id: 'w-1', status: 'done', report: 'Grid is fine.' }]
  }
  const daemon = defaultDaemon(api)
  expect(await daemon.dispatch('p', 't')).toBe('w-1')
  expect(await daemon.report('w-1', 30)).toEqual({ status: 'done', text: 'Grid is fine.' })
  expect(seen[1]).toContain('ids=w-1')
})

test('a consult tells the hidden worker to answer briefly and change nothing', async () => {
  writeDoc()
  const { daemon, calls } = fakeDaemon({ status: 'done', text: 'ok' })
  await use(
    dir,
    { chat, id: 'person:iris-ui', mode: 'consult', question: 'Is the grid right?' },
    daemon,
    now,
  )
  expect(calls.dispatch[0]?.prompt).toContain('at most 300 words; read only; change nothing')
})

import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TranscriptItem } from '@shared/protocol'
import { buildTranscriptIndex } from '../../shared/transcript-index'

const user = (id: string, text: string): TranscriptItem => ({ kind: 'user', id, ts: 1, text })
const formerFirstLine = (s: string) =>
  s
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? ''

test('first-line previews preserve the former newline, trim and UTF-16 behavior', () => {
  const cases = [
    '',
    '\n',
    '\r\n',
    '   ',
    ' \t\r\n\u00a0\n meaningful \r\n later',
    'one\u2028two\nthree',
    '\ufeff\n\u2029word\u2029\r\nlast',
    '🙂\nnext',
    String.fromCharCode(0xd800) + '\nnext',
    String.fromCharCode(0xdc00),
  ]
  const alphabet = [
    'x',
    ' ',
    '\t',
    '\r',
    '\n',
    'é',
    '🙂',
    '\u00a0',
    '\ufeff',
    '\u2028',
    String.fromCharCode(0xd800),
    String.fromCharCode(0xdc00),
  ]
  let seed = 77
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  for (let n = 0; n < 4096; n++) {
    cases.push(
      Array.from({ length: random(100) }, () => alphabet[random(alphabet.length)]).join(''),
    )
  }
  const items = cases.map((text, i) => user(`example-${i}`, text))
  const index = buildTranscriptIndex(items)
  expect(index.userMessages.map((m) => m.firstLine)).toEqual(cases.map(formerFirstLine))
  expect(index.userMessages.map((m) => [m.id, m.position])).toEqual(
    items.map((item, position) => [item.id, position]),
  )
  expect(index.lastUserText).toBe(cases.at(-1)!)
})

test('other index fields retain their order, original objects and newest full user text', () => {
  const latestText =
    'Newest full prompt\nincluding every later line\n🙂 ' + String.fromCharCode(0xd800)
  const todos: TranscriptItem = { kind: 'todos', id: 'todos', ts: 2, todos: [] }
  const running: TranscriptItem = {
    kind: 'task',
    id: 'running',
    ts: 3,
    taskId: 'running',
    description: 'Example running task',
    status: 'running',
  }
  const done: TranscriptItem = {
    kind: 'task',
    id: 'done',
    ts: 4,
    taskId: 'done',
    description: 'Example completed task',
    status: 'completed',
  }
  const items: TranscriptItem[] = [
    user('old', 'Old heading\n' + 'Invented pasted body\n'.repeat(1000)),
    todos,
    running,
    done,
    {
      kind: 'tool_use',
      id: 'tool-one',
      ts: 5,
      startedAt: 5,
      name: 'ExampleTool',
      input: {},
      status: 'done',
    },
    {
      kind: 'tool_use',
      id: 'tool-two',
      ts: 6,
      startedAt: 6,
      name: 'ExampleTool',
      input: {},
      status: 'error',
    },
    user('newest', latestText),
  ]
  const index = buildTranscriptIndex(items)
  expect(index.total).toBe(items.length)
  expect(index.latestTodos).toBe(todos)
  expect(index.runningTasks).toEqual([running])
  expect(index.runningTasks[0]).toBe(running)
  expect(index.recentTasks).toEqual([done])
  expect(index.recentTasks[0]).toBe(done)
  expect(index.tools).toEqual([{ name: 'ExampleTool', calls: 2, errors: 1 }])
  expect(index.userMessages).toEqual([
    { id: 'old', position: 0, firstLine: 'Old heading', images: 0 },
    { id: 'newest', position: 6, firstLine: 'Newest full prompt', images: 0 },
  ])
  expect(index.lastUserText).toBe(latestText)
})

test('an actual index stops after the selected line while preserving large previews and full latest text', async () => {
  const source = pathToFileURL(resolve(import.meta.dir, '../../shared/transcript-index.ts')).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { spyOn } from 'bun:test'
    const { buildTranscriptIndex } = await import(${JSON.stringify(source)})
    const short = 'Invented preview ' + '.'.repeat(80) + String.fromCharCode(0xd800)
    const long = 'Long invented preview ' + 'x'.repeat(100000) + String.fromCharCode(0xdc00)
    const texts = [
      short + '\\n' + 'discarded body line\\n'.repeat(60000),
      long + '\\n' + 'discarded body line\\n'.repeat(20000),
      'abc\\nxx',
      'abc\\nxxx',
      'a'.repeat(4096) + '\\n' + 'tail'.repeat(3000),
      'b'.repeat(4097) + '\\n' + 'tail'.repeat(3000),
      'Untouched single-line prompt',
    ]
    const original = String.prototype.trim
    let trimCalls = 0
    const spy = spyOn(String.prototype,'trim').mockImplementation(function(...args) {
      trimCalls++
      return Reflect.apply(original,this,args)
    })
    const originalSplit = String.prototype.split
    const splitGuard = spyOn(String.prototype,'split').mockImplementation(function(...args) {
      if (args[0] === '' && String(this).length > 4096) throw Error('Unbounded preview-copy array allocation')
      return Reflect.apply(originalSplit,this,args)
    })
    let index
    try { index = buildTranscriptIndex(texts.map((text,i)=>({kind:'user',id:'example-'+i,ts:i,text}))) }
    finally { splitGuard.mockRestore(); spy.mockRestore() }
    const expected = [short,long,'abc','abc','a'.repeat(4096),'b'.repeat(4097),texts[6]]
    if(index.userMessages.some((m,i)=>m.firstLine!==expected[i])) throw Error('Code units or previews changed')
    if(index.lastUserText!==texts[6]) throw Error('Full latest prompt changed')
    if(trimCalls>texts.length) throw Error('Discarded body lines were visited')
    process.stdout.write(JSON.stringify({trimCalls,lengths:index.userMessages.map(m=>m.firstLine.length),lastUnits:[index.userMessages[0].firstLine.charCodeAt(short.length-1),index.userMessages[1].firstLine.charCodeAt(long.length-1)]}))
  `,
    ],
    { windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exit, stderr).toBe(0)
  expect(stderr).toBe('')
  const result = JSON.parse(stdout) as { trimCalls: number; lengths: number[]; lastUnits: number[] }
  expect(result.trimCalls).toBeLessThanOrEqual(7)
  expect(result.lengths).toEqual([98, 100023, 3, 3, 4096, 4097, 28])
  expect(result.lastUnits).toEqual([0xd800, 0xdc00])
}, 20_000)

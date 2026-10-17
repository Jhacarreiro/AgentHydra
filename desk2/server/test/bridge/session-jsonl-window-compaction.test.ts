import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TranscriptItem } from '@shared/protocol'
import { createJsonlReader } from '../../src/bridge/session-jsonl'
import { historyToItems } from '../../src/engine/normalize'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'jsonl-window-'))
  homes.push(home)
  return { home, file: join(home, 'session.jsonl') }
}
afterEach(() => {
  for (const home of homes.splice(0)) {
    const target = resolve(home)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('jsonl-window-')
    )
      throw new Error('Refusing unexpected scratch cleanup')
    rmSync(target, { recursive: true, force: true })
  }
})

const options = (keepBytes: number, pinBytes = keepBytes) => ({
  tailBytes: 8 * 1024 * 1024,
  keepBytes,
  pinBytes,
  maxFiles: 4,
  maxBytes: 16 * 1024 * 1024,
  settledFiles: 8,
  settledBytes: 16 * 1024 * 1024,
})
const user = (n: number, text = `Invented line ${n}`) => ({
  type: 'user',
  uuid: `u-${n}`,
  timestamp: '2026-10-16T00:00:00.000Z',
  message: { role: 'user', content: text },
})
const assistant = (n: number, id: string, content: unknown[]) => ({
  type: 'assistant',
  uuid: `a-${n}`,
  timestamp: '2026-10-16T00:00:00.000Z',
  message: { role: 'assistant', id, content },
})
type Marked = { rec: unknown; bytes: number; mid?: string; uses?: string[] }

/** The former prefix-removal algorithm, kept as an ordering/pinning oracle. */
function oldWindow(recs: Marked[], items: TranscriptItem[], keep: number, cap: number) {
  const open = new Set<string>()
  for (const it of items) {
    if (it.kind === 'tool_use' && it.status === 'running') open.add(it.id)
    else if (it.kind === 'task' && it.status === 'running' && it.toolUseId) open.add(it.toolUseId)
  }
  let pin = open.size ? recs.findIndex((r) => r.uses?.some((id) => open.has(id))) : -1
  if (pin < 0) pin = recs.length
  let bytes = recs.reduce((sum, r) => sum + r.bytes, 0)
  let dropped = 0
  while (recs.length > 1 && bytes > keep) {
    let j = 1
    while (j < recs.length && recs[j]!.mid !== undefined && recs[j]!.mid === recs[j - 1]!.mid) j++
    if (j >= recs.length) break
    if (j > pin && bytes <= cap) break
    for (const r of recs.splice(0, j)) {
      bytes -= r.bytes
      dropped += r.bytes
    }
    pin -= j
  }
  return { recs, dropped }
}

test('window trimming moves the surviving record array once, with unchanged cached order', async () => {
  const { file } = fixture()
  const source = pathToFileURL(resolve(import.meta.dir, '../../src/bridge/session-jsonl.ts')).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { spyOn } from 'bun:test'
    import { writeFileSync } from 'node:fs'
    const { createJsonlReader } = await import(${JSON.stringify(source)})
    const file = ${JSON.stringify(file)}
    const records = Array.from({length:4096}, (_, i) => JSON.stringify({type:'user', uuid:'u-'+i, message:{role:'user',content:'Invented '+i+' '+'.'.repeat(80)}}))
    writeFileSync(file, records.join('\\n')+'\\n')
    const read = createJsonlReader(${JSON.stringify(options(8 * 1024))})
    const original = Array.prototype.splice
    let calls = 0, shifted = 0
    const spy = spyOn(Array.prototype, 'splice').mockImplementation(function(...args) {
      if (this[0]?.rec && typeof this[0]?.bytes === 'number') {
        calls++
        shifted += this.length - args[1]
      }
      return Reflect.apply(original, this, args)
    })
    let first, second, third
    try { first = read(file); second = read(file); third = read(file) }
    finally { spy.mockRestore() }
    if (first.length !== 4096 || second.length >= first.length || second !== third) throw Error('window/cache changed')
    const ids = second.map(i => i.id)
    if (ids.some((id,i) => id !== first[first.length-second.length+i].id)) throw Error('order changed')
    process.stdout.write(JSON.stringify({calls,shifted,kept:second.length}))
  `,
    ],
    { windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 },
  )
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, err).toBe(0)
  const result = JSON.parse(out) as { calls: number; shifted: number; kept: number }
  expect(result.calls).toBe(1)
  expect(result.shifted).toBe(result.kept)
}, 25_000)

test('mixed API-message groups and pinned tools match the previous algorithm across byte caps', async () => {
  const { home } = fixture()
  for (let trial = 0; trial < 24; trial++) {
    const recs: Marked[] = []
    const lines: string[] = []
    for (let n = 0; n < 120; n++) {
      const mid = n % 5 === 0 ? undefined : `msg-${Math.floor(n / 3)}`
      const uses = mid && (n + trial) % 17 === 0 ? [`tool-${n}`] : undefined
      const rec = mid
        ? assistant(
            n,
            mid,
            uses
              ? [{ type: 'tool_use', id: uses[0], name: 'Bash', input: { command: 'invented' } }]
              : [{ type: 'text', text: `Reply ${n} ${'.'.repeat((n + trial) % 80)}` }],
          )
        : user(n)
      const line = JSON.stringify(rec) + '\n'
      lines.push(line)
      recs.push({ rec, bytes: Buffer.byteLength(line), mid, uses })
    }
    const keep = 512 + trial * 79
    const cap = keep * (1 + (trial % 4))
    const first = historyToItems(recs.map((r) => r.rec))
    const old = oldWindow(recs.slice(), first, keep, cap)
    const expectedCached = old.dropped > keep ? historyToItems(old.recs.map((r) => r.rec)) : first
    const file = join(home, `trial-${trial}.jsonl`)
    writeFileSync(file, lines.join(''))
    const read = createJsonlReader(options(keep, cap))
    expect(await read.readAsync(file)).toEqual(first)
    expect(await read.readAsync(file)).toEqual(expectedCached)
  }
})

test('a pinned message stays whole within its cap and is released beyond it', () => {
  const { home } = fixture()
  const launch = assistant(0, 'launch', [
    { type: 'tool_use', id: 'tool-one', name: 'Bash', input: { command: 'invented' } },
  ])
  const finish = {
    type: 'user',
    uuid: 'finish',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-one', content: 'Complete' }],
    },
  }
  for (const count of [8, 80]) {
    const file = join(home, `pin-${count}.jsonl`)
    writeFileSync(
      file,
      [launch, ...Array.from({ length: count }, (_, i) => user(i, 'x'.repeat(200)))]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    const read = createJsonlReader(options(512, 8 * 1024))
    expect(read(file).find((i) => i.id === 'tool-one')).toMatchObject({ status: 'running' })
    appendFileSync(file, JSON.stringify(finish) + '\n')
    const item = read(file).find((i) => i.id === 'tool-one')
    if (count === 8) expect(item).toMatchObject({ status: 'done' })
    else expect(item?.kind === 'tool_use' ? item.status : undefined).not.toBe('done')
  }
})

test('valid unfinished lines and torn multibyte tails retain incremental ordering', async () => {
  const { file } = fixture()
  const records = Array.from({ length: 300 }, (_, i) => user(i, `Text ${i} ${'x'.repeat(80)}`))
  const next = user(301, 'café 🙂 ' + String.fromCharCode(0xd800))
  const last = JSON.stringify(next)
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  const encoded = Buffer.from(last)
  const emoji = encoded.indexOf(Buffer.from('🙂'))
  writeFileSync(file, Buffer.concat([Buffer.from(body), encoded.subarray(0, emoji + 2)]))
  const read = createJsonlReader(options(2048))
  expect((await read.readAsync(file)).at(-1)).toMatchObject({ id: 'u-299' })
  appendFileSync(file, encoded.subarray(emoji + 2))
  expect((await read.readAsync(file)).at(-1)).toMatchObject({
    id: 'u-301',
    text: next.message.content,
  })
  appendFileSync(file, '\n' + JSON.stringify(user(302, 'After the valid unfinished line')) + '\n')
  const items = await read.readAsync(file)
  expect(items.slice(-2).map((i) => i.id)).toEqual(['u-301', 'u-302'])
  expect(items.filter((i) => i.id === 'u-301')).toHaveLength(1)
})

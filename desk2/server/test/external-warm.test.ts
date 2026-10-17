// The poller's warm-up: the index of a recently active idle outside session is built once, kept by file size|mtime, and built
// again only when the file changed; a working session is left alone.
import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../src/bridge'

const SESSION = 'bbbbbbbb-1111-4222-8333-444444444444'
const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const line = (n: number) => JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(), message: { role: 'user', content: `ask ${n}` } }) + '\n'

test('warmIndexes builds an idle session once, again after its file grew, never a working one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-warm-home-'))
  temps.push(home)
  const root = join(home, 'projects')
  mkdirSync(join(root, 'C--Users-me-proj'), { recursive: true })
  const file = join(root, 'C--Users-me-proj', `${SESSION}.jsonl`)
  writeFileSync(file, line(0))
  const bridge = createBridge({ url: 'http://127.0.0.1:9', home, projectRoots: () => [root] })
  const row = (status: 'idle' | 'working') => [{ id: SESSION, cwd: null, status, lastActivityAt: 1 }]

  expect(await bridge.warmIndexes(row('working'))).toBe(false)
  expect(await bridge.warmIndexes(row('idle'))).toBe(true)
  expect(await bridge.warmIndexes(row('idle'))).toBe(false)
  expect((await bridge.externalIndex(SESSION)).userMessages).toHaveLength(1)

  appendFileSync(file, line(1))
  expect(await bridge.warmIndexes(row('idle'))).toBe(true)
  expect((await bridge.externalIndex(SESSION)).userMessages).toHaveLength(2)
})

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncFile } from '../src/async-file'
import { renameOverAsync } from '../src/write-flushed'

const dirs: string[] = []
function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-af-'))
  dirs.push(dir)
  return join(dir, 'state.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A rename that waits, for its first `holds` calls, until the test releases it. */
function holdingRename(holds: number) {
  const calls: string[] = []
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  let held = 0
  const rename = async (from: string, to: string) => {
    calls.push(from)
    if (held++ < holds) await gate
    await renameOverAsync(from, to)
  }
  return { rename, calls, release: () => open() }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** The retained input, checked without adding a production diagnostics API. */
const retained = (writer: AsyncFile): string | null =>
  (writer as unknown as { want: string | null }).want

describe('AsyncFile', () => {
  test('an idle writer releases its landed payload and accepts the next write', async () => {
    const file = scratchFile()
    const writer = new AsyncFile(file)
    const text = JSON.stringify({ rows: 'x'.repeat(8 * 1024 * 1024) })
    expect(await writer.write(text)).toBe(true)
    await writer.settled()
    expect(retained(writer)).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe(text)
    writer.flushSync()
    expect(retained(writer)).toBeNull()
    expect(await writer.write('newer')).toBe(true)
    await writer.settled()
    expect(retained(writer)).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe('newer')
  })

  test('a failed pending write keeps its payload until a synchronous flush lands it', async () => {
    const file = scratchFile()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    const writer = new AsyncFile(file, {
      retryMs: 60_000,
      rename: async () => {
        throw new Error('locked')
      },
    })
    try {
      expect(await writer.write('retry me')).toBe(false)
      await writer.quiet()
      expect(retained(writer)).toBe('retry me')
      writer.flushSync()
      expect(retained(writer)).toBeNull()
      expect(writer.ok).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('retry me')
    } finally {
      log.mockRestore()
    }
  })

  test('a write chained from an earlier receipt is preserved', async () => {
    const file = scratchFile()
    const writer = new AsyncFile(file)
    expect(await writer.write('one').then(() => writer.write('two'))).toBe(true)
    await writer.settled()
    expect(retained(writer)).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe('two')
  })

  test('the newest content lands last when a write comes while an earlier rename is held', async () => {
    const file = scratchFile()
    const hold = holdingRename(1)
    const writer = new AsyncFile(file, { rename: hold.rename })
    writer.write('one')
    await until(() => hold.calls.length === 1)
    writer.write('two')
    hold.release()
    await writer.settled()
    expect(readFileSync(file, 'utf8')).toBe('two')
  })

  test('writes queued behind a held rename are coalesced into the first and the last', async () => {
    const file = scratchFile()
    const hold = holdingRename(1)
    const writer = new AsyncFile(file, { rename: hold.rename })
    writer.write('1')
    await until(() => hold.calls.length === 1)
    for (const text of ['2', '3', '4', '5']) writer.write(text)
    hold.release()
    await writer.settled()
    expect(hold.calls.length).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('5')
  })

  test('a failed write is tried again and logged once per failure streak', async () => {
    const file = scratchFile()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    const writer = new AsyncFile(file, {
      retryMs: 5,
      rename: async (from, to) => {
        if (++attempts <= 2) throw new Error('locked')
        await renameOverAsync(from, to)
      },
    })
    writer.write('kept')
    expect(writer.ok).toBe(true)
    await writer.settled()
    expect(readFileSync(file, 'utf8')).toBe('kept')
    expect(writer.ok).toBe(true)
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  test('flushSync writes the newest content at once, and a late rename of older content does not undo it', async () => {
    const file = scratchFile()
    const hold = holdingRename(1)
    const writer = new AsyncFile(file, { rename: hold.rename })
    writer.write('one')
    await until(() => hold.calls.length === 1)
    writer.write('two')
    writer.flushSync()
    expect(readFileSync(file, 'utf8')).toBe('two')
    // The held old rename can still overwrite the sync flush: its repair needs this text.
    expect(retained(writer)).toBe('two')
    hold.release()
    await writer.settled()
    expect(readFileSync(file, 'utf8')).toBe('two')
    expect(retained(writer)).toBeNull()
  })

  test('a write resolves true once its content or a newer one is on disk', async () => {
    const file = scratchFile()
    const hold = holdingRename(1)
    const writer = new AsyncFile(file, { rename: hold.rename })
    const a = writer.write('A')
    await until(() => hold.calls.length === 1)
    const b = writer.write('B')
    hold.release()
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('B')
  })

  test('a write whose attempt fails resolves false, and the retry lands the content', async () => {
    const file = scratchFile()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    const writer = new AsyncFile(file, {
      retryMs: 5,
      rename: async (from, to) => {
        if (++attempts === 1) throw new Error('locked')
        await renameOverAsync(from, to)
      },
    })
    expect(await writer.write('kept')).toBe(false)
    await writer.settled()
    expect(readFileSync(file, 'utf8')).toBe('kept')
    expect(retained(writer)).toBeNull()
    log.mockRestore()
  })
})

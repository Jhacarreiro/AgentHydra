import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decodeFreeStdout, runFree, type RunOutput } from '../src/free-instances/runner'

test('stdout decoding views the exact backing slice instead of copying the output bytes', () => {
  const backing = new Uint8Array([0x61, 0x62, 0xf0, 0x9f, 0x99, 0x82, 0x63])
  const bytes = backing.subarray(2, 6)
  const from = spyOn(Buffer, 'from')
  try {
    expect(decodeFreeStdout(bytes)).toBe('🙂')
    expect(from).toHaveBeenCalledWith(bytes.buffer, 2, 4)
  } finally {
    from.mockRestore()
  }
})

test('small, large, empty and offset outputs preserve Buffer UTF-8 decoding', () => {
  const eightMiB = new Uint8Array(8 * 1024 * 1024).fill(0x78)
  const offset = new Uint8Array([0x78, 0x61, 0xe2, 0x82, 0xac, 0x79]).subarray(1, 5)
  for (const bytes of [new Uint8Array(), Buffer.from('Synthetic é🙂 result'), eightMiB, offset])
    expect(decodeFreeStdout(bytes)).toBe(Buffer.from(bytes).toString('utf8'))
})

test('BOM, malformed UTF-8 and split boundary sequences keep Buffer replacement semantics', () => {
  const cases = [
    new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
    new Uint8Array([0xff, 0xfe, 0x61, 0xc0, 0xaf]),
    new Uint8Array([0xf0, 0x9f, 0x99]),
    new Uint8Array([0xf0, 0x9f, 0x99, 0x82]).subarray(1, 3),
    new Uint8Array([0x78, 0xf0, 0x9f, 0x99, 0x82, 0x79]).subarray(1, 4),
  ]
  for (const bytes of cases)
    expect(decodeFreeStdout(bytes)).toBe(Buffer.from(bytes).toString('utf8'))
  expect(decodeFreeStdout(cases[0]!)).toBe('\ufeffa')
})

// Synthetic pipe output only; the real runner starts this interpreter with windowsHide.
const windowless = process.platform === 'win32' ? Bun.which('pythonw.exe') : null
const python =
  process.platform === 'win32'
    ? windowless && join(dirname(windowless), 'python.exe')
    : Bun.which('python3')

test.skipIf(!python || !existsSync(python))(
  'the real runner decodes a synthetic child output and preserves its exit code',
  async () => {
    if (!python) throw new Error('Synthetic runner fixture requires Python.')
    const root = mkdtempSync(join(tmpdir(), 'free-runner-stdout-'))
    const controller = new AbortController()
    let pending: Promise<RunOutput> | undefined
    try {
      const prefix = Buffer.from('\ufeffSynthetic result ')
      const suffix = new Uint8Array([0xf0, 0x9f, 0x99, 0x82, 0xff, 0x0a])
      writeFileSync(
        join(root, 'desk_entry.py'),
        [
          'import sys',
          `sys.stdout.buffer.write(bytes.fromhex('${prefix.toString('hex')}') + b'x' * (512 * 1024) + bytes.fromhex('${Buffer.from(suffix).toString('hex')}'))`,
          'sys.stdout.buffer.flush()',
          'sys.exit(7)',
        ].join('\n'),
      )
      pending = runFree(
        {
          python,
          harnessDir: root,
          stateDir: join(root, 'state'),
          cacheDir: join(root, 'cache'),
        },
        {
          requestId: crypto.randomUUID(),
          instanceId: crypto.randomUUID(),
          provider: 'claude',
          command: 'auth',
        },
        controller.signal,
      )
      const result = await pending
      expect(result.code).toBe(7)
      expect(result.stdout).toBe('\ufeffSynthetic result ' + 'x'.repeat(512 * 1024) + '🙂\ufffd\n')
    } finally {
      controller.abort()
      await pending?.catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  },
  20_000,
)

import { expect, spyOn, test } from 'bun:test'
import { capturePipedProc, spawnCaptured } from '../src/core/process'

const CHUNK = 64 * 1024
const CHUNKS = 128
const STDERR_BYTES = CHUNK * CHUNKS

/** Demand-driven bytes: all chunks can reuse one buffer without retaining a large fixture. */
function pipe(parts: Uint8Array[], fail = false) {
  let sent = 0
  let bytes = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const part = parts[sent++]
        if (part) {
          bytes += part.byteLength
          controller.enqueue(part)
        } else if (fail) controller.error(new Error('Synthetic pipe failure'))
        else controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, bytes: () => bytes }
}

function decoderCounts() {
  const NativeDecoder = TextDecoder
  let decodedBytes = 0
  let decoders = 0
  // Bun's spy supports constructors; its callable type requires this narrow facade.
  const globals = globalThis as unknown as {
    TextDecoder: (...args: ConstructorParameters<typeof TextDecoder>) => TextDecoder
  }
  const spy = spyOn(globals, 'TextDecoder').mockImplementation((...args) => {
    decoders++
    const decoder = new NativeDecoder(...args)
    const decode = decoder.decode.bind(decoder)
    decoder.decode = (input, options) => {
      decodedBytes += input?.byteLength ?? 0
      return decode(input, options)
    }
    return decoder
  })
  return {
    decodedBytes: () => decodedBytes,
    decoders: () => decoders,
    restore: () => spy.mockRestore(),
  }
}

function child(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
  code: number,
) {
  return {
    stdout,
    stderr,
    exited: Promise.resolve(code),
    exitCode: code,
    killed: false,
  } as unknown as Bun.Subprocess<'ignore', 'pipe', 'pipe'>
}

for (const wantStderr of [false, true]) {
  for (const outcome of ['success', 'nonzero', 'pipe-error'] as const) {
    test(`inline capture ${outcome}: wanted stderr=${wantStderr}, bytes always drain`, async () => {
      // Split a multi-byte stdout character across chunks to exercise streaming decoding.
      const text = new TextEncoder().encode('Synthetic stdout 🙂\n')
      const out = pipe([text.subarray(0, text.length - 3), text.subarray(text.length - 3)])
      const err = pipe(Array(CHUNKS).fill(new Uint8Array(CHUNK).fill(78)), outcome === 'pipe-error')
      const code = outcome === 'success' ? 0 : 7
      const count = decoderCounts()
      try {
        const result = await capturePipedProc(child(out.stream, err.stream, code), { wantStderr })
        expect(result).toMatchObject({ code, stdout: 'Synthetic stdout 🙂\n', timedOut: false })
        expect(out.bytes()).toBe(text.byteLength)
        expect(err.bytes()).toBe(STDERR_BYTES)
        expect(count.decoders()).toBe(wantStderr ? 2 : 1)
        expect(count.decodedBytes()).toBe(text.byteLength + (wantStderr ? STDERR_BYTES : 0))
        expect(result.stderr.length).toBe(wantStderr ? STDERR_BYTES : 0)
        if (wantStderr) {
          expect(result.stderr.startsWith('NNNN')).toBe(true)
          expect(result.stderr.endsWith('NNNN')).toBe(true)
        }
        expect(out.stream.locked).toBe(false)
        expect(err.stream.locked).toBe(false)
      } finally {
        count.restore()
      }
    })
  }

  test(`inline timeout retains stdout and only wanted stderr=${wantStderr}`, async () => {
    const text = new TextEncoder().encode('Synthetic output before deadline\n')
    const out = pipe([text])
    let close!: () => void
    let sent = 0
    const chunk = new Uint8Array(CHUNK).fill(78)
    const stderr = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          close = () => controller.close()
        },
        pull(controller) {
          if (sent < CHUNKS) {
            sent++
            controller.enqueue(chunk)
          }
        },
      },
      { highWaterMark: 0 },
    )
    const count = decoderCounts()
    const ending = setTimeout(close, 30)
    try {
      const result = await capturePipedProc(child(out.stream, stderr, 7), {
        timeoutMs: 5,
        wantStderr,
      })
      expect(result).toMatchObject({
        code: 7,
        stdout: 'Synthetic output before deadline\n',
        timedOut: true,
      })
      expect(sent).toBe(CHUNKS)
      expect(count.decoders()).toBe(wantStderr ? 2 : 1)
      expect(count.decodedBytes()).toBe(text.byteLength + (wantStderr ? STDERR_BYTES : 0))
      expect(result.stderr.length).toBe(wantStderr ? STDERR_BYTES : 0)
      expect(stderr.locked).toBe(false)
    } finally {
      clearTimeout(ending)
      count.restore()
    }
  })

  test(`worker capture drains large stderr with wanted stderr=${wantStderr}`, async () => {
    const result = await spawnCaptured(
      [
        process.execPath,
        '-e',
        `const chunk = 'N'.repeat(${CHUNK}); for (let i=0; i<${CHUNKS}; i++) process.stderr.write(chunk); process.stdout.write('Synthetic worker output 🙂\\n'); process.exitCode = 7`,
      ],
      { timeoutMs: 15_000, lane: 'stderr-discard-synthetic', wantStderr },
    )
    expect(result).toMatchObject({
      code: 7,
      stdout: 'Synthetic worker output 🙂\n',
      timedOut: false,
    })
    expect(result.stderr.length).toBe(wantStderr ? STDERR_BYTES : 0)
    if (wantStderr) {
      expect(result.stderr.startsWith('NNNN')).toBe(true)
      expect(result.stderr.endsWith('NNNN')).toBe(true)
    }
  }, 40_000)
}

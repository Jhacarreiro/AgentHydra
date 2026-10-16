import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callCodexAppPipe, codexAppPipesForPid } from '../src/core/codex-app-tools'

async function withPipe(
  handler: (socket: Socket) => void,
  run: (pipe: string) => Promise<void>,
  prefix = 'hydra-app-tools-test-',
) {
  const name = `${prefix}${randomUUID()}`
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), name)
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    handler(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipe, resolve)
  })
  try {
    await run(pipe)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function frame(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value))
  const result = Buffer.alloc(4 + payload.length)
  result.writeUInt32LE(payload.length)
  payload.copy(result, 4)
  return result
}

test('reads fragmented native app frames and ignores unrelated responses', async () => {
  await withPipe(
    (socket) =>
      socket.once('data', (chunk) => {
        const request = JSON.parse(Buffer.from(chunk).subarray(4).toString())
        expect(request.method).toBe('tools/list')
        const response = Buffer.concat([
          frame({ jsonrpc: '2.0', id: 2, result: {} }),
          frame({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
        ])
        socket.write(response.subarray(0, 2))
        setTimeout(() => socket.write(response.subarray(2)), 5)
      }),
    async (pipe) => {
      expect(await callCodexAppPipe<{ tools: unknown[] }>(pipe, 'tools/list', {})).toEqual({
        tools: [],
      })
    },
  )
})

// Codex 26.1013 serves its app tools on codex-app-tools-* pipes; discovery that looked only at codex-browser-use-*
// found nothing, and restoring an Unassigned chat failed with "app-tools connection could not be found" (2026-10-16).
test.skipIf(process.platform !== 'win32')(
  'finds the app-tools pipe a Codex app serves by its own pid',
  async () => {
    await withPipe(
      () => {},
      async (pipe) => {
        expect(await codexAppPipesForPid(process.pid)).toContain(pipe)
      },
      'codex-app-tools-',
    )
  },
)

test('native refusals are surfaced without a second dispatch', async () => {
  let dispatches = 0
  await withPipe(
    (socket) =>
      socket.on('data', () => {
        dispatches++
        socket.write(frame({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'Refused' } }))
      }),
    async (pipe) => {
      await expect(callCodexAppPipe(pipe, 'tools/call', {})).rejects.toThrow('Refused')
      expect(dispatches).toBe(1)
    },
  )
})

test('oversized frames and missing replies fail within a bounded wait', async () => {
  await withPipe(
    (socket) =>
      socket.once('data', () => {
        const header = Buffer.alloc(4)
        header.writeUInt32LE(8 * 1024 * 1024 + 1)
        socket.write(header)
      }),
    async (pipe) => {
      await expect(callCodexAppPipe(pipe, 'tools/list', {})).rejects.toThrow('too large')
    },
  )
  await withPipe(
    () => {},
    async (pipe) => {
      await expect(callCodexAppPipe(pipe, 'tools/call', {}, 50)).rejects.toThrow('timed out')
    },
  )
})

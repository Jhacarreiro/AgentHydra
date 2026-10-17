import { expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeInstances } from '../src/free-instances/service'
import { FreeSync, writeLogin } from '../src/free-instances/sync'

test.skipIf(process.platform !== 'win32')(
  'an already pending remote read cannot overwrite a newly staged login or re-adopt a retired row',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'free-pool-sync-'))
    const runtime: FreeRuntime = {
      ready: () => true,
      ensure: async () => {},
      config: (id) => ({
        harnessDir: home,
        python: join(home, 'unused-python.exe'),
        stateDir: join(home, 'free', 'instances', id),
        cacheDir: join(home, 'cache'),
      }),
    }
    const service = new FreeInstances(
      home,
      async () => {
        throw new Error('No provider operations in a sync fixture')
      },
      runtime,
    )
    const host = service.syncHost()
    const account = service.create({ provider: 'chatgpt', name: 'Example account' })
    Object.assign(account, {
      email: 'account@example.test',
      plan: 'free',
      loggedIn: true,
      checkedAt: Date.now(),
    })
    const file = host.sessionFile(account)
    const login = (marker: string) =>
      expect(
        writeLogin(
          file,
          'chatgpt',
          ['__Secure-next-auth.session-token', '_uasid', '_umsid'].map((name) => ({
            name,
            value: `${name}-${marker}`,
            domain: '.chatgpt.com',
            path: '/',
            expires: -1,
          })),
        ),
      ).toBe(true)
    login('shared-original')
    type Row = { id: string; version: number; blob: string; meta: unknown }
    const rows = new Map<string, Row>()
    const cloud = {
      url: 'http://127.0.0.1:1',
      token: 'invented-offline-token',
      key: randomBytes(32),
    }
    const sync = new FreeSync(home, host, async () => cloud)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holdRead = false
    let reads = 0
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    const calls: string[] = []
    // Exercise the real reconcile/encryption/writer path, replacing only its network boundary.
    ;(
      sync as unknown as {
        call: (
          c: unknown,
          method: string,
          path: string,
          body?: unknown,
        ) => Promise<{ status: number; json: unknown }>
      }
    ).call = async (_creds, method, path, body) => {
      calls.push(`${method} ${path}`)
      if (path === '/v1/free')
        return {
          status: 200,
          json: { free: [...rows.values()].map(({ blob: _blob, ...row }) => row) },
        }
      const id = path.slice('/v1/free/'.length)
      if (method === 'GET') {
        reads++
        if (holdRead) {
          reading()
          await held
        }
        return { status: 200, json: rows.get(id) }
      }
      const value = body as { version: number; blob: string; meta: unknown }
      if ((rows.get(id)?.version ?? 0) !== value.version) return { status: 409, json: {} }
      rows.set(id, { id, version: value.version + 1, blob: value.blob, meta: value.meta })
      return { status: 200, json: { version: value.version + 1 } }
    }
    let pass: Promise<void> | undefined
    try {
      await sync.pass()
      expect(rows.size).toBe(1)
      // A newer remote row and a missing local login take the genuine landing path after the remote await.
      rows.get(account.id)!.version++
      rmSync(file)
      holdRead = true
      pass = sync.pass()
      await started
      await service.admitPool({
        requestId: randomUUID(),
        provider: 'chatgpt',
        email: account.email,
        plan: 'free',
        limit: 40,
        instanceId: account.id,
      })
      login('staged-incoming')
      const incoming = readFileSync(file)
      release()
      await pass
      expect(readFileSync(file)).toEqual(incoming)
      expect(account.poolState).toBe('pending')
      expect(service.status().jobs).toEqual([])
      const before = reads
      for (const state of ['pending', 'retired'] as const) {
        account.poolState = state
        await sync.pass()
        expect(reads).toBe(before)
        expect(service.allInstances()).toHaveLength(1)
        expect(readFileSync(file)).toEqual(incoming)
      }
      expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1)
      expect(rows.get(account.id)!.meta).toEqual({})
    } finally {
      release()
      await pass
      sync.stop()
      await service.settled()
      await service.stop()
      rmSync(home, { recursive: true, force: true })
    }
  },
  30_000,
)

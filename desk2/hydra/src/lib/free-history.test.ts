import { expect, it } from 'bun:test'
import type { FreeThread } from '@desk/shared/free-instances'
import { FreeApiError, freeApi } from './free-instances'

const thread: FreeThread = {
  id: 'synthetic-account/synthetic-chat', instanceId: 'synthetic-account', provider: 'claude',
  chatId: 'synthetic-chat', title: 'Synthetic thread', status: 'done', createdAt: 1, updatedAt: 1, error: null,
}

it('conditional history accepts 304 without parsing a body and receives changed rows on 200', async () => {
  const original = globalThis.fetch
  const requests: Array<{ version: string | null; cache: RequestCache | undefined }> = []
  let next = new Response(JSON.stringify([thread]), { headers: { ETag: '"first"' } })
  globalThis.fetch = (async (_url: string | URL, options?: RequestInit) => {
    requests.push({ version: new Headers(options?.headers).get('If-None-Match'), cache: options?.cache })
    return next
  }) as typeof fetch
  try {
    const initial = await freeApi.changedThreads(null)
    expect(initial).toEqual({ threads: [thread], version: '"first"' })
    next = new Response(null, { status: 304, headers: { ETag: '"first"' } })
    Object.defineProperty(next, 'json', { value: () => { throw new Error('A 304 has no JSON body') } })
    expect(await freeApi.changedThreads(initial.version)).toEqual({ threads: null, version: '"first"' })
    next = new Response(JSON.stringify([{ ...thread, title: 'Changed synthetic thread' }]), { headers: { ETag: '"second"' } })
    const changed = await freeApi.changedThreads(initial.version)
    expect(changed.version).toBe('"second"')
    expect(changed.threads?.[0]?.title).toBe('Changed synthetic thread')
    expect(requests).toEqual([
      { version: null, cache: 'no-store' },
      { version: '"first"', cache: 'no-store' },
      { version: '"first"', cache: 'no-store' },
    ])
  } finally { globalThis.fetch = original }
})

it('old servers keep returning arrays, clear old validators and leave raw history reads unchanged', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify([thread]))) as unknown as typeof fetch
  try {
    expect(await freeApi.changedThreads('"old"')).toEqual({ threads: [thread], version: null })
    expect(await freeApi.threads()).toEqual([thread])
  } finally { globalThis.fetch = original }
})

it('history errors and an unsolicited initial 304 stay errors instead of hiding the list', async () => {
  const original = globalThis.fetch
  let next = new Response(null, { status: 304 })
  globalThis.fetch = (async () => next) as unknown as typeof fetch
  try {
    await expect(freeApi.changedThreads(null)).rejects.toBeInstanceOf(FreeApiError)
    next = new Response(JSON.stringify({ error: 'Synthetic unavailable history' }), { status: 503 })
    await expect(freeApi.changedThreads('"previous"')).rejects.toThrow('Synthetic unavailable history')
  } finally { globalThis.fetch = original }
})

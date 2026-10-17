import { afterEach, expect, spyOn, test } from 'bun:test'
import { getCliMayteWorker, listCliMayteWorkers } from './api'

let fetchSpy: { mockRestore(): void } | undefined
afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

test('only the pane list opts into the additive compact flag and preserves query scopes', async () => {
  const urls: URL[] = []
  const mockFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      urls.push(new URL(String(input), 'http://example.test'))
      return Response.json([])
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(mockFetch)
  await listCliMayteWorkers({ group: 'example group', active: true, limit: 0 })
  expect(urls[0]!.pathname).toBe('/api/corch/workers')
  expect([...urls[0]!.searchParams]).toEqual([
    ['group', 'example group'],
    ['active', '1'],
    ['limit', '0'],
    ['lean', '1'],
    ['pane', '1'],
  ])
  // An older daemon can ignore pane and still receives the same lean request and filters.
  urls[0]!.searchParams.delete('pane')
  expect([...urls[0]!.searchParams]).toEqual([
    ['group', 'example group'],
    ['active', '1'],
    ['limit', '0'],
    ['lean', '1'],
  ])
  await listCliMayteWorkers()
  expect([...urls[1]!.searchParams]).toEqual([
    ['lean', '1'],
    ['pane', '1'],
  ])
  await getCliMayteWorker('example-worker')
  expect(urls[2]!.pathname).toBe('/api/corch/workers/example-worker')
  expect([...urls[2]!.searchParams]).toEqual([['prompt', 'full']])
})

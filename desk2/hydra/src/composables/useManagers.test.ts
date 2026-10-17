// 2026-10-16: the Managers pages read Desk's routes through API_BASE, which this copy's build sets to '/ah' (the
// daemon's prefix: vite.config.ts), so in the real window every read went to /ah/api/* and answered 404, and the pages
// said "Runs in Hydra Desk" from the day they were added (62e44c74, 2026-10-12) until this was found.
import { expect, it } from 'bun:test'
import { nextTick, ref } from 'vue'
import type { BabysitterStatus } from '@desk/shared/babysitter'
import { useManagers } from './useManagers'

const babysitter: BabysitterStatus = {
  enabled: true,
  everyMs: 300_000,
  checkedAt: 1,
  nextCheckAt: null,
  error: null,
  accounts: [],
  acts: [],
  stopped: [
    {
      id: 'chat-1',
      session: null,
      title: 'Example chat',
      cwd: 'C:/Users/me/work',
      source: 'desktop',
      account: 'example',
      stoppedAt: 1,
      notice: null,
      resetsAt: null,
      state: 'waiting',
      reason: '',
      tries: 0,
    },
  ],
}

it("the managers' pages read Desk's own routes, not the daemon's", async () => {
  const realFetch = globalThis.fetch
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  if (!hadWindow) g.window = globalThis
  // Desk's server as the window sees it: its own /api/* answers; anything else (/ah/api/*, the daemon's) has no such route.
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url)
    if (!path.startsWith('/api/')) return new Response('not found', { status: 404 })
    const body = path === '/api/babysitter' ? babysitter : path === '/api/routines' ? { enabled: true, routines: [], proposals: [] } : {}
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const shown = ref(true)
  try {
    const managers = useManagers(shown)
    await managers.refresh()
    expect([managers.available, managers.error, managers.babysitter?.stopped.length]).toEqual([true, null, 1])
  } finally {
    shown.value = false
    await nextTick()
    globalThis.fetch = realFetch
    if (!hadWindow) delete g.window
  }
})

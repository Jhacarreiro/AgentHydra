// Where your people live (Settings → People): /api/people-store/* goes on to AgentHydra's /api/people-store/*
// (server/src/people-store/), which keeps the people on this PC or in the person's Connections account.
// Only Desk 2's own page may call it (own-page.ts); Desk's localOnly guard runs first on every route.
import type { Context, Hono } from 'hono'
import { bridge } from '../bridge'
import { notOwnPage } from '../own-page'

const WHAT = "the people store's API"

export default function plugin(app: Hono): void {
  app.all('/api/people-store', (c) => pass(c))
  app.all('/api/people-store/*', (c) => pass(c))
}

async function pass(c: Context): Promise<Response> {
  const why = notOwnPage(c.req.raw.headers, WHAT)
  if (why) return c.json({ error: why }, 403)
  const url = new URL(c.req.url)
  const withBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
  try {
    const res = await fetch(`${bridge().url}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: withBody ? { 'content-type': 'application/json' } : undefined,
      body: withBody ? await c.req.text() : undefined,
      // A sign-in waits for the person's browser, so the call may take minutes.
      signal: c.req.raw.signal
    })
    return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
  } catch {
    return c.json({ error: `AgentHydra is not answering at ${bridge().url}` }, 503)
  }
}

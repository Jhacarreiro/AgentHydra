// The by-id index reads of externalSessions() for status rows the 24 h answer misses. Only a claude-cloud row is
// read: with the cloud source off there are none, so the list makes the same requests origin/main makes.
import { afterEach, describe, expect, test } from 'bun:test'
import { createBridge } from '../../src/bridge'
import { type FakeHydra, freshState, NOW, startFakeHydra } from './fake-hydra'

const fakes: FakeHydra[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})

const LOCAL = '00000000-0000-4000-8000-0000000c0101'
const CLOUD = '00000000-0000-4000-8000-0000000c0102'
const OLD = new Date(NOW - 48 * 3600_000).toISOString()

/** A status row two days old, the way the claude-hook and rate-limit writers leave one (sessionId, source, state). */
function statusRow(sessionId: string, source: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    state,
    mainState: state === 'done' ? 'done' : 'working',
    subagents: 0,
    waiting: state === 'blocked' ? 'permission' : null,
    source,
    event: 'Notification',
    cwd: 'C:/Users/me/proj',
    at: OLD,
    restoredUnconfirmed: false,
    ...extra,
  }
}

async function byIdReads(agentStatus: unknown[], id: string): Promise<number> {
  const f = await startFakeHydra({ ...freshState(), agentStatus, sessions: [] })
  fakes.push(f)
  await createBridge({ url: f.url, now: () => NOW }).externalSessions()
  return f.gets.filter((g) => g.split('?')[0] === `/api/sessions/${id}`).length
}

describe('externalSessions by-id reads of old status rows', () => {
  test('a stale local blocked row (claude-hook) makes no by-id read, as origin/main makes none', async () => {
    // Regression: the bridge read every not-done status id, so a local blocked row older than 24 h cost a request per refresh.
    expect(await byIdReads([statusRow(LOCAL, 'claude-hook', 'blocked')], LOCAL)).toBe(0)
  })

  test('a stale rate-limit row makes no by-id read either', async () => {
    expect(await byIdReads([statusRow(LOCAL, 'rate-limit', 'blocked')], LOCAL)).toBe(0)
  })

  test('a not-done claude-cloud row is read by id, so its row has its title', async () => {
    expect(await byIdReads([statusRow(CLOUD, 'claude-cloud', 'working')], CLOUD)).toBe(1)
  })

  test('a done or restored claude-cloud row is not read by id', async () => {
    expect(await byIdReads([statusRow(CLOUD, 'claude-cloud', 'done')], CLOUD)).toBe(0)
    expect(await byIdReads([statusRow(CLOUD, 'claude-cloud', 'blocked', { restoredUnconfirmed: true })], CLOUD)).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'
import type { ChatSummary, CliMayteWorker } from '@shared/protocol'
import { seatsLabel, seatsOf } from '../../src/components/tasks/seats'

const MIN = 60_000
const NOW = 1_000 * MIN

function chat(id: string, over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    sessionId: `s-${id}`,
    title: id,
    cwd: 'C:/work/alpha',
    account: { id: '68', label: '#68', configDir: null, number: 68 },
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: true,
    status: 'idle',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...over
  }
}

function worker(id: string, origin: string, over: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    title: id,
    group: null,
    status: 'running',
    active: true,
    account: '#41',
    model: null,
    effort: null,
    kind: 'code',
    cwd: null,
    sessionId: `ws-${id}`,
    originSessionId: origin,
    startedAt: NOW - 30 * MIN,
    endedAt: null,
    lastActivityAt: null,
    lastActivity: null,
    usedPct: null,
    tokens: null,
    verdict: null,
    error: null,
    ...over
  }
}

const seat = (id: string, name: string, createdAt: number, over: Partial<ChatSummary> = {}) =>
  chat(id, { parentId: 'prime', title: `${name} · Checkout flow`, createdAt, workerId: `own-${id}`, ...over })

describe('seatsOf: the parent chat sums up the seats it opened', () => {
  const prime = chat('prime')
  const chats = [
    prime,
    // Opened first; idle now, but the two agents it started still run, so it is at work.
    seat('ava', 'Ava', 1, { climayteActive: 2, workerIds: ['w1'] }),
    seat('leo', 'Leo', 2, { status: 'working', turnStartedAt: NOW - 50 * MIN, manager: { slug: 'leo-design', name: 'Leo', title: null, oneLiner: null, photo: null, role: 'seat' } }),
    seat('mia', 'Mia', 3, { status: 'needs_you', pendingCount: 1 }),
    seat('noah', 'Noah', 4),
    // Another chat's seat and an archived seat of this one are not this chat's live seats.
    chat('other-seat', { parentId: 'elsewhere', status: 'working' }),
    seat('old', 'Old', 5, { archived: true, status: 'working' })
  ]
  const workers = [
    worker('w1', 'unrelated-session', { eta: { minutes: 40, at: NOW - 10 * MIN, tookS: null } }), // listed in Ava's workerIds
    worker('w2', 's-ava', { eta: { minutes: 90, at: NOW - 20 * MIN, tookS: null } }), // started from Ava's session
    worker('w3', 's-ava', { status: 'done', active: false, eta: { minutes: 600, at: NOW - 60 * MIN, tookS: 900 } }), // finished
    // The worker Leo's chat runs as is the seat, not an agent it started; its own estimate (100 min, said 10 min ago) counts.
    worker('own-leo', 's-leo', { chat: true, eta: { minutes: 100, at: NOW - 10 * MIN, tookS: null } }),
    worker('w4', 's-prime') // the parent's own worker belongs to its tasks line
  ]

  test('needs you first, then working, by opening order; idle seats only counted; agents and estimate from the seats\' live workers', () => {
    const s = seatsOf(prime, chats, workers)!
    expect(s.total).toBe(4)
    expect(s.groups.map((g) => [g.verb, g.seats.map((x) => x.name)])).toEqual([
      ['needs you', ['Mia']],
      ['working', ['Ava', 'Leo']]
    ])
    expect(s.agents).toBe(2)
    // Leo's own 100 min from 10 min ago outlasts w2's 90 from 20 min ago and w1's; the finished w3 no longer counts.
    expect(seatsLabel(s, NOW)).toBe('4 seats · Mia needs you · Ava, Leo working · 2 agents running · about 1 h 30 min left')
  })

  test('without an estimate it says how long the working seats have been at it', () => {
    const plain = workers.map((w) => ({ ...w, eta: null }))
    expect(seatsLabel(seatsOf(prime, chats, plain)!, NOW)).toBe('4 seats · Mia needs you · Ava, Leo working · 2 agents running · 50 min so far')
  })

  test('every seat idle reads none working; a chat with no seats gets no line', () => {
    const quiet = [prime, seat('ava', 'Ava', 1), seat('leo', 'Leo', 2)]
    expect(seatsLabel(seatsOf(prime, quiet, [])!, NOW)).toBe('2 seats · none working')
    expect(seatsOf(chat('lonely'), chats, workers)).toBeNull()
  })
})

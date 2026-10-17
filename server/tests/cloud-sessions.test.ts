// server/src/cloud-sessions.ts - the opt-in claude.ai session poller. Its contract is that a session
// reads working, needs you or done the way claude.ai shows it; its regressions are that a session
// which leaves the list is released, that a failed, refused or rate-limited account changes nothing,
// and that a refused tagged query costs only the tagged sessions. Its seam is fetch in, a per-account
// snapshot and claude-cloud status rows out. With the flag unset nothing runs.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CloudAccount } from '../src/cloud-sessions'

// db.ts opens the file on import, so the scratch home has to be in place first (same pattern as
// agent-status.test.ts).
const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-cloud-sessions-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = scratch

// The claude-cloud adapter lists only while the flag is on and a login resolves to the account, so
// the tests run with one login made in the scratch home.
const previousEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  AGENTHYDRA_CLOUD_SESSIONS: process.env.AGENTHYDRA_CLOUD_SESSIONS,
}
const LOGIN = join(scratch, 'login')
mkdirSync(LOGIN, { recursive: true })
writeFileSync(
  join(LOGIN, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'example-token-not-real',
      scopes: ['user:inference', 'user:sessions:claude_code'],
      expiresAt: Date.now() + 3_600_000,
    },
  }),
)
writeFileSync(
  join(LOGIN, '.claude.json'),
  JSON.stringify({
    oauthAccount: {
      accountUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
      organizationUuid: 'example-org',
    },
  }),
)
process.env.CLAUDE_CONFIG_DIR = LOGIN
process.env.AGENTHYDRA_CLOUD_SESSIONS = '1'

const { getAgentStatus } = await import('../src/agent-status')
const { listForeignSessions } = await import('../src/foreign-sessions')
const { isListedCloudRow, readCloudSnapshot, writeCloudSnapshot } = await import(
  '../src/cloud-sessions-root'
)
const { cloudAccounts, newCloudSyncState, startCloudSessions, syncCloudSessions, toCloudRow } =
  await import('../src/cloud-sessions')

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // db.ts's handle is shared by every test file in the run, so it stays open. On Windows the scratch
  // home can be locked by it, so the cleanup is best-effort and can never fail the run.
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // scratch cleanup is best-effort
  }
})

const ACCOUNT: CloudAccount = {
  key: 'aaaaaaaa-0000-4000-8000-000000000001',
  token: 'example-token-not-real',
  orgUuid: null,
}

interface Reply {
  status: number
  body?: unknown
  retryAfter?: string
}

/** A fake of the sessions endpoint. `route` answers the untagged query (false) or the tagged one (true). */
function serve(route: (tagged: boolean) => Reply) {
  const calls: string[] = []
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url)
    const r = route(new URL(url).searchParams.has('tags'))
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: r.retryAfter ? { 'retry-after': r.retryAfter } : {},
    })
  }
  return { fetchFn, calls }
}

const ok = (data: unknown[]): Reply => ({ status: 200, body: { data, next_cursor: null } })

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Example ${id}`,
  status_bucket: 'completed',
  worker_status: 'idle',
  environment_kind: 'anthropic_cloud',
  unread: false,
  last_event_at: '2026-10-17T10:00:00.000Z',
  tags: [],
  ...over,
})

describe('cloud session status', () => {
  test('a session reads working, needs you or done as claude.ai shows it, and the adapter lists it', async () => {
    const root = join(scratch, 'contract')
    const { fetchFn } = serve((tagged) =>
      tagged
        ? ok([])
        : ok([
            item('cloud-contract-run', { worker_status: 'running' }),
            item('cloud-contract-blocked', { status_bucket: 'blocked' }),
            item('cloud-contract-unread', { unread: true }),
            item('cloud-contract-done'),
          ]),
    )
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })

    expect(getAgentStatus('cloud-contract-run')).toMatchObject({
      state: 'working',
      source: 'claude-cloud',
    })
    expect(getAgentStatus('cloud-contract-blocked')).toMatchObject({
      state: 'blocked',
      waiting: 'input',
    })
    expect(getAgentStatus('cloud-contract-unread')).toMatchObject({
      state: 'blocked',
      waiting: 'unread',
    })
    expect(getAgentStatus('cloud-contract-done')).toMatchObject({ state: 'done' })
    expect(listForeignSessions('claude-cloud', root).map((s) => s.session_id)).toEqual(
      expect.arrayContaining([
        'cloud-contract-run',
        'cloud-contract-blocked',
        'cloud-contract-unread',
        'cloud-contract-done',
      ]),
    )
  })

  test('a Project thread waits on its bucket alone, since its unread flag never clears', async () => {
    const root = join(scratch, 'project')
    const project = { tags: ['hearth-thread'], unread: true }
    const { fetchFn } = serve((tagged) =>
      tagged
        ? ok([
            item('cloud-project-read', project),
            item('cloud-project-review', { ...project, status_bucket: 'review_ready' }),
          ])
        : ok([]),
    )
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })

    expect(getAgentStatus('cloud-project-read')).toMatchObject({ state: 'done' })
    expect(getAgentStatus('cloud-project-review')).toMatchObject({
      state: 'blocked',
      waiting: 'review',
    })
  })

  test('a Remote Control session is not listed, since its local copy already is', async () => {
    const root = join(scratch, 'bridge')
    const { fetchFn } = serve((tagged) =>
      tagged
        ? ok([])
        : ok([item('cloud-bridge-copy', { environment_kind: 'bridge', status_bucket: 'blocked' })]),
    )
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })

    expect(getAgentStatus('cloud-bridge-copy')).toBeNull()
    expect(listForeignSessions('claude-cloud', root)).toEqual([])
  })

  test('only remote kinds are listed: a cowork-local run and an unknown kind are not, a Project thread is', async () => {
    const root = join(scratch, 'kinds')
    const { fetchFn } = serve((tagged) =>
      tagged
        ? ok([])
        : ok([
            item('cloud-kind-local', {
              environment_kind: 'local',
              tags: ['cowork-local'],
              status_bucket: 'blocked',
            }),
            item('cloud-kind-unknown', {
              environment_kind: 'some_new_kind',
              status_bucket: 'blocked',
            }),
            item('cloud-kind-project', {
              environment_kind: 'some_new_kind',
              tags: ['hearth-thread'],
              status_bucket: 'review_ready',
            }),
            item('cloud-kind-remote', { status_bucket: 'blocked' }),
          ]),
    )
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })

    expect(getAgentStatus('cloud-kind-local')).toBeNull()
    expect(getAgentStatus('cloud-kind-unknown')).toBeNull()
    expect(getAgentStatus('cloud-kind-project')).toMatchObject({
      state: 'blocked',
      waiting: 'review',
    })
    expect(getAgentStatus('cloud-kind-remote')).toMatchObject({ state: 'blocked' })
  })
})

describe('cloud session release', () => {
  test('a session that leaves the list loses its row, so it does not read as waiting for ever', async () => {
    const root = join(scratch, 'release')
    let listed = [item('cloud-release-a', { status_bucket: 'blocked' }), item('cloud-release-b')]
    const { fetchFn } = serve((tagged) => (tagged ? ok([]) : ok(listed)))

    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })
    expect(getAgentStatus('cloud-release-a')).toMatchObject({ state: 'blocked' })

    listed = [item('cloud-release-b')]
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })
    expect(getAgentStatus('cloud-release-a')).toBeNull()
    expect(getAgentStatus('cloud-release-b')).not.toBeNull()
  })

  test('a failed or refused list removes nothing, and the snapshot keeps its sessions', async () => {
    const root = join(scratch, 'failed')
    let reply: Reply = ok([item('cloud-failed-a', { status_bucket: 'blocked' })])
    const { fetchFn } = serve((tagged) => (tagged ? ok([]) : reply))
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })

    for (const failure of [{ status: 401 }, { status: 500 }]) {
      reply = failure
      await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })
      expect(getAgentStatus('cloud-failed-a')).toMatchObject({ state: 'blocked' })
      expect(
        readCloudSnapshot(join(root, ACCOUNT.key))
          .filter(isListedCloudRow)
          .map((r) => r.id),
      ).toEqual(['cloud-failed-a'])
    }
  })

  test('a refused tagged query costs only the tagged sessions: the untagged ones still update', async () => {
    const root = join(scratch, 'tagged')
    let untagged: Reply = ok([item('cloud-tagged-plain', { status_bucket: 'blocked' })])
    let tagged: Reply = ok([
      item('cloud-tagged-project', { tags: ['hearth-thread'], status_bucket: 'review_ready' }),
    ])
    const { fetchFn } = serve((isTagged) => (isTagged ? tagged : untagged))
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })
    expect(getAgentStatus('cloud-tagged-project')).toMatchObject({
      state: 'blocked',
      waiting: 'review',
    })

    untagged = ok([item('cloud-tagged-plain', { last_event_at: '2026-10-17T11:00:00.000Z' })])
    tagged = { status: 400 }
    const [result] = await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })

    expect(result?.outcome).toBe('partial')
    expect(getAgentStatus('cloud-tagged-plain')).toMatchObject({ state: 'done' })
    expect(getAgentStatus('cloud-tagged-project')).toMatchObject({
      state: 'blocked',
      waiting: 'review',
    })
    // Carried forward, so a later clean pass can release it.
    expect(
      readCloudSnapshot(join(root, ACCOUNT.key))
        .filter(isListedCloudRow)
        .map((r) => r.id),
    ).toContain('cloud-tagged-project')
  })

  test('a refused account keeps its sessions, while a clean account still releases its own', async () => {
    const root = join(scratch, 'per-account')
    const SECOND: CloudAccount = {
      key: 'bbbbbbbb-0000-4000-8000-000000000002',
      token: 'example-token-second',
      orgUuid: null,
    }
    let firstListed = [item('cloud-two-a', { status_bucket: 'blocked' })]
    const secondListed = [item('cloud-two-b', { status_bucket: 'blocked' })]
    let secondRefused = false
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
      const tagged = new URL(url).searchParams.has('tags')
      const second = String((init.headers as Record<string, string>).Authorization).endsWith(
        SECOND.token,
      )
      const r: Reply = !second
        ? tagged
          ? ok([])
          : ok(firstListed)
        : secondRefused
          ? { status: 401 }
          : tagged
            ? ok([])
            : ok(secondListed)
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status })
    }
    const accounts = [ACCOUNT, SECOND]
    await syncCloudSessions({ root, accounts, fetchFn })
    expect(getAgentStatus('cloud-two-a')).toMatchObject({ state: 'blocked' })
    expect(getAgentStatus('cloud-two-b')).toMatchObject({ state: 'blocked' })

    firstListed = []
    secondRefused = true
    await syncCloudSessions({ root, accounts, fetchFn })
    expect(getAgentStatus('cloud-two-a')).toBeNull()
    expect(getAgentStatus('cloud-two-b')).toMatchObject({ state: 'blocked' })
  })

  test('a rate-limited account is not asked again until its back-off ends', async () => {
    const root = join(scratch, 'backoff')
    const state = newCloudSyncState()
    const { fetchFn, calls } = serve(() => ({ status: 429, retryAfter: '120' }))
    const start = 1_000_000

    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn, state, now: start })
    const afterFirst = calls.length
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn, state, now: start + 60_000 })
    expect(calls.length).toBe(afterFirst)

    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn, state, now: start + 121_000 })
    expect(calls.length).toBeGreaterThan(afterFirst)
  })

  test('a rate-limited tagged query backs the account off as well', async () => {
    const root = join(scratch, 'backoff-tagged')
    const state = newCloudSyncState()
    const { fetchFn, calls } = serve((tagged) =>
      tagged ? { status: 429, retryAfter: '120' } : ok([]),
    )
    const start = 2_000_000

    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn, state, now: start })
    const afterFirst = calls.length
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn, state, now: start + 60_000 })
    expect(calls.length).toBe(afterFirst)
  })
})

describe('cloud session switch', () => {
  test('with AGENTHYDRA_CLOUD_SESSIONS unset nothing runs: no request, no folder', () => {
    const dir = join(scratch, 'off-by-default')
    const realFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      return new Response('{}')
    }) as unknown as typeof fetch
    try {
      expect(startCloudSessions({ AGENTHYDRA_CLOUD_SESSIONS_DIR: dir })).toBe(false)
      expect(
        startCloudSessions({ AGENTHYDRA_CLOUD_SESSIONS: '0', AGENTHYDRA_CLOUD_SESSIONS_DIR: dir }),
      ).toBe(false)
      expect(requests).toBe(0)
      expect(existsSync(dir)).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('with the flag off the claude-cloud adapter lists nothing, even a snapshot an earlier opt-in left', async () => {
    const root = join(scratch, 'flag-off-leftover')
    const { fetchFn } = serve(() => ok([item('cloud-leftover')]))
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })
    expect(listForeignSessions('claude-cloud', root).map((s) => s.session_id)).toEqual([
      'cloud-leftover',
    ])

    process.env.AGENTHYDRA_CLOUD_SESSIONS = '0'
    try {
      expect(listForeignSessions('claude-cloud', root)).toEqual([])
    } finally {
      process.env.AGENTHYDRA_CLOUD_SESSIONS = '1'
    }
  })

  test('the adapter lists only the accounts the last poll named, and nothing with no index', async () => {
    // A folder for a login that is gone: the poll does not name its account, so its sessions stay unlisted.
    const root = join(scratch, 'index-filter')
    const gone = 'bbbbbbbb-0000-4000-8000-000000000002'
    writeCloudSnapshot(root, gone, [
      {
        id: 'cloud-gone',
        title: 'Example cloud-gone',
        environment_kind: 'anthropic_cloud',
        status_bucket: 'completed',
        worker_status: 'idle',
        unread: false,
        created_at: null,
        last_event_at: '2026-10-17T10:00:00.000Z',
        tags: [],
      },
    ])
    const { fetchFn } = serve(() => ok([item('cloud-kept')]))
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })
    expect(listForeignSessions('claude-cloud', root).map((s) => s.session_id)).toEqual([
      'cloud-kept',
    ])

    rmSync(join(root, 'accounts.json'))
    expect(listForeignSessions('claude-cloud', root)).toEqual([])
  })
})

describe('cloud session input', () => {
  test('an id that is not a plain string is refused, so no row holds a number or an object', () => {
    // A numeric id was written and listed as a number, and the title search then threw on it.
    expect(toCloudRow({ ...item('cloud-x'), id: 42 } as never)).toBeNull()
    expect(toCloudRow({ ...item('cloud-x'), id: { a: 1 } } as never)).toBeNull()
    expect(toCloudRow({ ...item('cloud x / y') } as never)).toBeNull()
  })

  test('each field is typed on the way in: a bad title defaults, a long one is cut, dates are ISO, a bad last event drops the row', () => {
    const row = toCloudRow({ ...item('cloud-typed'), title: 7, tags: 'hearth-thread' } as never)
    expect(row).toMatchObject({ title: 'Claude Code session', tags: [] })
    const long = toCloudRow({ ...item('cloud-long'), title: 'x'.repeat(900) })
    expect(long?.title.length).toBe(500)
    const dated = toCloudRow({ ...item('cloud-dated'), created_at: '2026-10-17T09:00:00+02:00' })
    expect(dated?.created_at).toBe('2026-10-17T07:00:00.000Z')
    expect(toCloudRow({ ...item('cloud-bad-date'), last_event_at: 'not a date' })).toBeNull()
  })

  test('a row the list does not name is skipped when read, while its good neighbours still list', () => {
    // A snapshot an older branch wrote could hold a Remote Control row and a numeric id.
    const root = join(scratch, 'bad-rows')
    const good = toCloudRow(item('cloud-good-row'))
    const bridge = { ...good, id: 'cloud-bridge-row', environment_kind: 'bridge' }
    const numeric = { ...good, id: 9 }
    mkdirSync(join(root, ACCOUNT.key), { recursive: true })
    writeFileSync(
      join(root, ACCOUNT.key, 'sessions.json'),
      JSON.stringify({ sessions: [good, bridge, numeric] }),
    )
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({ accounts: [ACCOUNT.key] }))
    expect(listForeignSessions('claude-cloud', root).map((s) => s.session_id)).toEqual([
      'cloud-good-row',
    ])
  })

  test('one account whose pass throws stays in that account: the next one still lists and releases', async () => {
    // A file where the first account's folder goes makes its snapshot write throw.
    const root = join(scratch, 'one-throws')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'bad-account'), '')
    const { fetchFn } = serve((tagged) => ok(tagged ? [] : [item('cloud-after-throw')]))
    const results = await syncCloudSessions({
      root,
      accounts: [
        { ...ACCOUNT, key: 'bad-account' },
        { ...ACCOUNT, key: 'good-account' },
      ],
      fetchFn,
    })
    expect(results.map((r) => r.outcome)).toEqual(['failed', 'clean'])
    expect(getAgentStatus('cloud-after-throw')).toMatchObject({ state: 'done' })
  })

  test('a tagged query the server refused is not asked again with the same token, and a new token tries again', async () => {
    // Before, a refused tagged query was sent on every 60 s pass, and logged each time.
    const root = join(scratch, 'tagged-refused')
    const { fetchFn, calls } = serve((tagged) =>
      tagged ? { status: 403 } : ok([item('cloud-refused-plain')]),
    )
    const taggedCalls = () => calls.filter((u) => new URL(u).searchParams.has('tags')).length
    const state = newCloudSyncState()
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn, state })
    expect(taggedCalls()).toBe(1)
    await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn, state })
    expect(taggedCalls()).toBe(1)
    expect(getAgentStatus('cloud-refused-plain')).toMatchObject({ state: 'done' })
    await syncCloudSessions({
      root,
      accounts: [{ ...ACCOUNT, token: 'example-token-renewed' }],
      fetchFn,
      state,
    })
    expect(taggedCalls()).toBe(2)
  })

  test.skipIf(process.platform === 'win32')(
    'the snapshot is private: its folder 0700 and its file 0600',
    async () => {
      // Session titles are chat text. Windows ignores POSIX modes, so this runs on the other platforms only.
      const root = join(scratch, 'modes')
      const { fetchFn } = serve((tagged) => ok(tagged ? [] : [item('cloud-private')]))
      await syncCloudSessions({ root, accounts: [ACCOUNT], fetchFn })
      const dir = join(root, ACCOUNT.key)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, 'sessions.json')).mode & 0o777).toBe(0o600)
    },
  )
})

describe('cloud session accounts', () => {
  test('the identity file is read once while it is unchanged, and again once it changes', () => {
    // A read shows as the uuid the file names. With the mtime and size held, a changed uuid must not
    // show, since the answer is cached. Moving the mtime or the size must show it.
    const dir = join(scratch, 'identity-cache')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'example-token-not-real',
          scopes: ['user:inference', 'user:sessions:claude_code'],
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    )
    const file = join(dir, '.claude.json')
    const identity = (uuid: string, pad = '') =>
      JSON.stringify({ oauthAccount: { accountUuid: uuid, organizationUuid: 'example-org' }, pad })
    const env = { CLAUDE_CONFIG_DIR: dir }
    const keys = () => cloudAccounts(env).map((a) => a.key)
    const T0 = new Date('2026-10-17T10:00:00Z')
    const T1 = new Date('2026-10-17T11:00:00Z')
    const A = 'aaaaaaaa-0000-4000-8000-000000000001'
    const B = 'aaaaaaaa-0000-4000-8000-000000000002'

    writeFileSync(file, identity(A))
    utimesSync(file, T0, T0)
    expect(keys()).toEqual([A])

    // Same size and mtime: the file is not read again, so the new uuid does not show.
    writeFileSync(file, identity(B))
    utimesSync(file, T0, T0)
    expect(keys()).toEqual([A])

    // A new mtime: read again.
    utimesSync(file, T1, T1)
    expect(keys()).toEqual([B])

    // A new size with the same mtime: read again.
    writeFileSync(file, identity(A, 'x'.repeat(8)))
    utimesSync(file, T1, T1)
    expect(keys()).toEqual([A])
  })
})

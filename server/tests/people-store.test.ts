import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryLocker } from '@cnct/connect'
import {
  backupDir,
  createConnectionsAdapter,
  createPeopleService,
  createThisPcHome,
  lockerKey,
  NOT_CONFIGURED,
  type PersonRecord,
  syncPeople,
} from '../src/people-store'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'people-store-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const person = (
  slug: string,
  updatedAt: string,
  extra: Partial<PersonRecord> = {},
): PersonRecord => ({
  id: `manager/${slug}`,
  family: 'manager',
  slug,
  persona: { name: `Example ${slug}`, oneLiner: 'Picks the right tool.' },
  brief: `Brief of ${slug}`,
  learnings: [],
  updatedAt,
  ...extra,
})

const fakeConnect = (signedIn = true) => ({
  isSignedIn: async () => signedIn,
  getAccessToken: async () => 'token',
  getUser: async () => ({ name: 'Example Owner', email: 'owner@example.com' }),
  signInLoopback: async () => ({}),
  signOut: async () => {},
})

test('This PC home: put, get, list, delete keep the docs/PEOPLE.md folders', async () => {
  const pc = createThisPcHome({ home })
  await pc.put(
    person('ada', '2026-01-01T00:00:00.000Z', {
      learnings: [{ id: 'l1', text: 'Ask first', at: '2026-01-01T00:00:00.000Z' }],
    }),
  )
  expect(existsSync(join(home, '.agenthydra', 'people', 'manager', 'ada', 'persona.json'))).toBe(
    true,
  )
  const got = await pc.get('manager/ada')
  expect(got?.brief).toBe('Brief of ada')
  expect(got?.learnings[0]?.text).toBe('Ask first')
  expect(got?.updatedAt).toBe('2026-01-01T00:00:00.000Z')
  expect((await pc.list()).map((p) => p.name)).toEqual(['Example ada'])
  await pc.delete('manager/ada')
  expect(await pc.get('manager/ada')).toBeNull()
})

test('This PC home refuses an id that could leave the people folder', async () => {
  const pc = createThisPcHome({ home })
  expect(await pc.get('manager/../x')).toBeNull()
  await expect(
    pc.put({ ...person('ok', '2026-01-01T00:00:00.000Z'), id: 'manager/../evil' }),
  ).rejects.toThrow()
})

test('Connections home: one person is one locker key, round trip through the memory locker', async () => {
  const locker = createMemoryLocker()
  const cn = createConnectionsAdapter({ home, appId: 'app-test', locker, connect: fakeConnect() })
  const h = cn.home()
  await h.put(person('ada', '2026-01-01T00:00:00.000Z'))
  const doc = await locker.get()
  expect(Object.keys(doc.settings)).toEqual([lockerKey('me', 'manager/ada')])
  expect((await h.get('manager/ada'))?.persona.name).toBe('Example ada')
  expect((await h.list()).length).toBe(1)
  await h.delete('manager/ada')
  expect((await h.list()).length).toBe(0)
})

test('Connections home: a company scope is not available yet and says so', async () => {
  const cn = createConnectionsAdapter({
    home,
    appId: 'app-test',
    scope: 'company-1',
    locker: createMemoryLocker(),
    connect: fakeConnect(),
  })
  await expect(cn.home().list()).rejects.toThrow('not available yet')
})

test('sync: a person only on one side is copied to the other, and a pull rebuilds the catalog', async () => {
  const pc = createThisPcHome({ home })
  const locker = createMemoryLocker()
  const remote = createConnectionsAdapter({
    home,
    appId: 'a',
    locker,
    connect: fakeConnect(),
  }).home()
  await pc.put(person('mine', '2026-01-01T00:00:00.000Z'))
  await remote.put(person('theirs', '2026-01-02T00:00:00.000Z'))
  let rebuilt = 0
  const r = await syncPeople({
    local: pc,
    remote,
    backupDir: backupDir(home),
    afterPull: () => void rebuilt++,
  })
  expect(r).toMatchObject({ pulled: 1, pushed: 1, error: null })
  expect(rebuilt).toBe(1)
  expect(await pc.get('manager/theirs')).not.toBeNull()
  expect(await remote.get('manager/mine')).not.toBeNull()
})

test('sync conflict: newer wins and the losing copy is kept in the backup folder', async () => {
  const pc = createThisPcHome({ home })
  const remote = createConnectionsAdapter({
    home,
    appId: 'a',
    locker: createMemoryLocker(),
    connect: fakeConnect(),
  }).home()
  await pc.put(person('ada', '2026-01-01T00:00:00.000Z', { brief: 'old pc brief' }))
  await remote.put(person('ada', '2026-02-01T00:00:00.000Z', { brief: 'newer remote brief' }))
  const r = await syncPeople({ local: pc, remote, backupDir: backupDir(home) })
  expect(r.backedUp).toBe(1)
  expect((await pc.get('manager/ada'))?.brief).toBe('newer remote brief')
  const stamps = readdirSync(backupDir(home))
  const files = readdirSync(join(backupDir(home), stamps[0] as string))
  expect(files).toEqual(['pc--manager--ada.json'])
  expect(
    readFileSync(join(backupDir(home), stamps[0] as string, files[0] as string), 'utf8'),
  ).toContain('old pc brief')
  // Equal now: a second sync changes nothing.
  expect(await syncPeople({ local: pc, remote, backupDir: backupDir(home) })).toMatchObject({
    pulled: 0,
    pushed: 0,
    backedUp: 0,
  })
})

test('a failed sync reports in words and deletes no local file', async () => {
  const pc = createThisPcHome({ home })
  await pc.put(person('ada', '2026-01-01T00:00:00.000Z'))
  const broken = {
    ...createConnectionsAdapter({
      home,
      appId: 'a',
      locker: createMemoryLocker(),
      connect: fakeConnect(),
    }).home(),
    list: async () => Promise.reject(new Error('offline')),
  }
  const r = await syncPeople({ local: pc, remote: broken, backupDir: backupDir(home) })
  expect(r.error).toBe('offline')
  expect(await pc.get('manager/ada')).not.toBeNull()
})

test('no app id: Connections says it is not configured and This PC keeps working', async () => {
  const svc = createPeopleService({ home, adapter: createConnectionsAdapter({ home, appId: '' }) })
  const st = await svc.status()
  expect(st).toMatchObject({ home: 'pc', configured: false, signedIn: false, note: NOT_CONFIGURED })
  await expect(svc.setHome('connections')).rejects.toThrow(NOT_CONFIGURED)
  await svc.put(person('ada', '2026-01-01T00:00:00.000Z'))
  expect((await svc.list()).length).toBe(1)
  expect((await svc.status()).home).toBe('pc')
})

test('the service on Connections: setting it syncs, and a change pushes after the debounce', async () => {
  const locker = createMemoryLocker()
  const adapter = createConnectionsAdapter({ home, appId: 'a', locker, connect: fakeConnect() })
  const svc = createPeopleService({ home, adapter, rebuild: async () => {}, debounceMs: 5 })
  await svc.local.put(person('ada', '2026-01-01T00:00:00.000Z'))
  await svc.setHome('connections')
  await svc.syncNow()
  expect(await adapter.home().get('manager/ada')).not.toBeNull()
  await svc.addLearning('manager/ada', 'Read the brief first')
  await new Promise((r) => setTimeout(r, 80))
  expect((await adapter.home().get('manager/ada'))?.learnings.length).toBe(1)
  const st = await svc.status()
  expect(st).toMatchObject({ home: 'connections', signedIn: true, error: null })
  expect(st.account?.name).toBe('Example Owner')
  expect(statSync(join(home, '.agenthydra', 'people-store.json')).isFile()).toBe(true)
})

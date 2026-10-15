import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backupDir,
  createCrainiumHome,
  createPeopleService,
  createThisPcHome,
  findDoor,
  HomeUnavailable,
  type PeopleHome,
  type PersonRecord,
  syncPeople,
} from '../src/people-store'

const FAKE = join(import.meta.dir, 'fixtures', 'fake-people-door.mjs')
let home = ''
let db = ''
let log = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'people-store-'))
  db = join(home, 'door-db.json')
  log = join(home, 'door-log.txt')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const door = (): string[] => [process.execPath, FAKE, db, log]
const verbs = (): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
const remoteHome = (): PeopleHome => createCrainiumHome(door())

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

test('sync both ways through the door, and a pull rebuilds the catalog', async () => {
  const pc = createThisPcHome({ home })
  const remote = remoteHome()
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
  const remote = remoteHome()
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
  expect(await syncPeople({ local: pc, remote, backupDir: backupDir(home) })).toMatchObject({
    pulled: 0,
    pushed: 0,
    backedUp: 0,
  })
  // The other way: a newer PC copy goes up and the old CrAInium copy is backed up as crainium--.
  await pc.put(person('ada', '2026-03-01T00:00:00.000Z', { brief: 'newest pc brief' }))
  const up = await syncPeople({ local: pc, remote, backupDir: backupDir(home) })
  expect(up).toMatchObject({ pushed: 1, backedUp: 1 })
  expect((await remote.get('manager/ada'))?.brief).toBe('newest pc brief')
  const all = readdirSync(backupDir(home)).flatMap((d) => readdirSync(join(backupDir(home), d)))
  expect(all).toContain('crainium--manager--ada.json')
})

test('playbook and avatar files round-trip byte-exact through the door and This PC', async () => {
  const pc = createThisPcHome({ home })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 1, 2, 3, 250])
  const avatar = { path: 'avatar.png', base64: png.toString('base64') }
  const playbook = { path: 'playbook/rules.md', text: 'Line one\r\nLine two\n\n  tail  ' }
  await remoteHome().put(person('ada', '2026-01-01T00:00:00.000Z', { files: [avatar, playbook] }))
  await syncPeople({ local: pc, remote: remoteHome(), backupDir: backupDir(home) })
  const dir = join(home, '.agenthydra', 'people', 'manager', 'ada')
  expect(readFileSync(join(dir, 'avatar.png')).equals(png)).toBe(true)
  expect(readFileSync(join(dir, 'playbook', 'rules.md'), 'utf8')).toBe(playbook.text)
  const got = await pc.get('manager/ada')
  expect(got?.files).toEqual([playbook, avatar])
  expect(got?.updatedAt).toBe('2026-01-01T00:00:00.000Z')
  // A pulled record with no files removes nothing on disk, and a file nobody knows is never read or sent.
  writeFileSync(join(dir, 'notes.txt'), 'mine')
  await pc.put({ ...(got as PersonRecord), files: [] })
  expect(existsSync(join(dir, 'playbook', 'rules.md'))).toBe(true)
  expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  expect((await pc.get('manager/ada'))?.files?.map((f) => f.path)).toEqual([
    'playbook/rules.md',
    'avatar.png',
  ])
})

test('an unreachable door raises HomeUnavailable and deletes nothing local', async () => {
  const pc = createThisPcHome({ home })
  await pc.put(person('ada', '2026-01-01T00:00:00.000Z'))
  writeFileSync(`${db}.down`, '')
  await expect(remoteHome().list()).rejects.toBeInstanceOf(HomeUnavailable)
  const r = await syncPeople({ local: pc, remote: remoteHome(), backupDir: backupDir(home) })
  expect(r.error).toContain('not reachable')
  expect(await pc.get('manager/ada')).not.toBeNull()
  const missing = createCrainiumHome([join(home, 'no-such-command')])
  await expect(missing.list()).rejects.toBeInstanceOf(HomeUnavailable)
})

test('delete never reaches the door', async () => {
  const remote = remoteHome()
  await remote.put(person('ada', '2026-01-01T00:00:00.000Z'))
  await remote.delete('manager/ada')
  expect(verbs()).not.toContain('delete')
  expect(await remote.get('manager/ada')).not.toBeNull()
})

test('a stale put is nothing to push, not a failure', async () => {
  const remote = remoteHome()
  await remote.put(person('ada', '2026-02-01T00:00:00.000Z', { brief: 'kept' }))
  await remote.put(person('ada', '2026-01-01T00:00:00.000Z', { brief: 'older' }))
  expect((await remote.get('manager/ada'))?.brief).toBe('kept')
})

test('a saved connections home reads as This PC, and CrAInium is refused without a door', async () => {
  mkdirSync(join(home, '.agenthydra'), { recursive: true })
  writeFileSync(
    join(home, '.agenthydra', 'people-store.json'),
    JSON.stringify({ home: 'connections', lastSync: null }),
  )
  const svc = createPeopleService({ home, door: null })
  expect(svc.config().home).toBe('pc')
  const st = await svc.status()
  expect(st).toMatchObject({ home: 'pc', crainium: { available: false } })
  expect(st.crainium.reason).toBeTruthy()
  await expect(svc.setHome('crainium')).rejects.toThrow('not set up')
  await svc.put(person('ada', '2026-01-01T00:00:00.000Z'))
  expect((await svc.list()).length).toBe(1)
})

test('the service on CrAInium: status from the door, setting it syncs, a change pushes after the debounce', async () => {
  const remote = remoteHome()
  const svc = createPeopleService({ home, door: door(), rebuild: async () => {}, debounceMs: 5 })
  expect((await svc.status()).crainium).toMatchObject({ available: true, owner: 'example' })
  await svc.local.put(person('ada', '2026-01-01T00:00:00.000Z'))
  await svc.setHome('crainium')
  await svc.syncNow()
  expect(await remote.get('manager/ada')).not.toBeNull()
  await svc.addLearning('manager/ada', 'Read the brief first')
  // The push runs the door after the 5 ms debounce: waited for, up to 10 s, not a fixed 800 ms (the door's round trip
  // passed 800 ms on a loaded PC: 1 run in 3 failed alone, 2026-10-15).
  const until = Date.now() + 10_000
  while (((await remote.get('manager/ada'))?.learnings.length ?? 0) < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  expect((await remote.get('manager/ada'))?.learnings.length).toBe(1)
  expect(await svc.status()).toMatchObject({ home: 'crainium', error: null })
  expect(statSync(join(home, '.agenthydra', 'people-store.json')).isFile()).toBe(true)
}, 30_000)

test('findDoor reads the settings command (array or quoted string), else the private checkout', () => {
  const dir = join(home, '.agenthydra')
  mkdirSync(dir, { recursive: true })
  const none = { home, env: {}, appRoot: join(home, 'AgentHydra') }
  expect(findDoor(none)).toBeNull()
  writeFileSync(
    join(dir, 'people-store.json'),
    JSON.stringify({ crainium: { command: 'node "C:/a b/door.mjs" --x' } }),
  )
  expect(findDoor(none)).toEqual(['node', 'C:/a b/door.mjs', '--x'])
  writeFileSync(
    join(dir, 'people-store.json'),
    JSON.stringify({ crainium: { command: ['node', 'd.mjs'] } }),
  )
  expect(findDoor(none)).toEqual(['node', 'd.mjs'])
  rmSync(join(dir, 'people-store.json'))
  mkdirSync(join(home, 'sue-dredd', 'store'), { recursive: true })
  writeFileSync(join(home, 'sue-dredd', 'store', 'people-door.mjs'), '')
  expect(findDoor(none)).toEqual([
    process.execPath,
    join(home, 'sue-dredd', 'store', 'people-door.mjs'),
  ])
})

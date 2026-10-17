import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliInstancesInUse, refreshPoolSessions } from '../src/climayte-core'
import { CONFIG_DIR } from '../src/config'
import { listCliInstances } from '../src/core/cli-instances'
import type { CliInstance } from '../src/types'

const registry = join(CONFIG_DIR, 'cli-instances.json')
let previous: Buffer | null
let scratch: string
const restores: Array<() => void> = []
beforeEach(() => {
  previous = fs.existsSync(registry) ? fs.readFileSync(registry) : null
  scratch = fs.mkdtempSync(join(tmpdir(), 'ah-pool-projection-'))
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
})
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  if (previous === null) fs.rmSync(registry, { force: true })
  else fs.writeFileSync(registry, previous)
  fs.rmSync(scratch, { recursive: true, force: true })
})

function account(id: string, signedIn = true) {
  const configDir = join(scratch, `${id}-config`)
  fs.mkdirSync(configDir)
  if (signedIn) fs.writeFileSync(join(configDir, '.credentials.json'), '{"claudeAiOauth":{}}')
  return { id, configDir, associatedDesktopDir: null } as CliInstance
}
function store(accounts: CliInstance[]) {
  fs.writeFileSync(registry, JSON.stringify({ instances: accounts }))
}
function session(account: CliInstance) {
  fs.mkdirSync(join(account.configDir, 'sessions'))
  fs.writeFileSync(
    join(account.configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: crypto.randomUUID(), cwd: account.configDir }),
  )
}

test('session refresh never reads plan or identity files, and recent accounts skip credential probes', async () => {
  const first = account('synthetic-pool-first')
  store([first])
  const reads = spyOn(fs, 'readFileSync')
  const exists = spyOn(fs, 'existsSync')
  restores.push(
    () => reads.mockRestore(),
    () => exists.mockRestore(),
  )
  const now = Date.now()
  await refreshPoolSessions(now)
  const readsOf = (name: string) => () =>
    reads.mock.calls.filter((call) => String(call[0]).endsWith(name)).length
  const identityReads = readsOf('.claude.json')
  const credentialReads = readsOf('.credentials.json')
  // The first refresh of a never-seen account reads its credentials once, to tell a cleared login
  // (isLoggedIn, a3da0e61). Its plan and identity files are never read.
  expect(identityReads()).toBe(0)
  expect(credentialReads()).toBe(1)
  reads.mockClear()
  exists.mockClear()
  await refreshPoolSessions(now + 1000)
  expect(
    exists.mock.calls.filter((call) => String(call[0]).endsWith('.credentials.json')),
  ).toHaveLength(0)
  expect(identityReads()).toBe(0)
  expect(credentialReads()).toBe(0)
  // Verify the read spy observes the old hydration path rather than silently missing its imports.
  listCliInstances()
  expect(identityReads() + credentialReads()).toBeGreaterThan(0)
}, 30_000)

test('new and newly signed-in accounts are discovered while another account is inside its refresh interval', async () => {
  const first = account('synthetic-pool-current')
  const relogged = account('synthetic-pool-relogged', false)
  store([first, relogged])
  const now = Date.now()
  await refreshPoolSessions(now)
  const added = account('synthetic-pool-added')
  session(added)
  session(relogged)
  fs.writeFileSync(join(relogged.configDir, '.credentials.json'), '{}')
  store([first, relogged, added])
  await refreshPoolSessions(now + 1000)
  const busy = cliInstancesInUse([first, relogged, added], now + 1000)
  expect(busy.has(first.id)).toBe(false)
  expect(busy.has(relogged.id)).toBe(true)
  expect(busy.has(added.id)).toBe(true)
}, 30_000)

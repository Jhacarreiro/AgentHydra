import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = (name: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/core', name)).href)

interface Result {
  before: number
  peak: number
  active: number
  firstCounts: { readdir: number; stat: number }
  exact: boolean
  recoveries: number
  quotaRecovery: number
}

test('past login listings and record stats share the eight filesystem slots and recover after faults', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-login-history-fs-quota-'))
  mkdirSync(join(home, 'data'))
  try {
    const program = `
      import { spyOn } from 'bun:test'
      import * as fs from 'node:fs'
      import * as fsp from 'node:fs/promises'
      import { join } from 'node:path'
      const home = ${JSON.stringify(home)}
      const { readPastLogins } = await import(${source('login-history.ts')})
      const { fsSlot } = await import(${source('fs-slots.ts')})
      const { normalizePath } = await import(${source('paths.ts')})
      const assert = (value, message) => { if (!value) throw new Error(message) }
      const uuid = i => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0')
      const roots = Array.from({ length: 16 }, (_, profile) => {
        const root = join(home, 'profile-' + profile)
        for (let account = 0; account < 3; account++) for (let org = 0; org < 2; org++) {
          const dir = join(root, 'claude-code-sessions', uuid(account), 'org-' + org)
          fs.mkdirSync(dir, { recursive: true })
          for (let record = 0; record < 4; record++) {
            const path = join(dir, 'local_' + record + '.json')
            fs.writeFileSync(path, '{}')
            const at = new Date(1_700_000_000_000 + profile * 100_000 + account * 10_000 + org * 1_000 + record * 100)
            fs.utimesSync(path, at, at)
          }
          fs.writeFileSync(join(dir, 'ignored.txt'), '{}')
        }
        fs.mkdirSync(join(root, 'claude-code-sessions', 'not-an-account'))
        fs.writeFileSync(join(root, 'claude-code-sessions', uuid(99)), '{}')
        return root
      })
      // The original directory order and newest stat define the exact result, independent of OS ordering.
      const expected = roots.map(root => fs.readdirSync(join(root, 'claude-code-sessions'), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^00000000-0000-4000-8000-/.test(entry.name))
        .map(entry => {
          let last = 0
          for (const org of fs.readdirSync(join(root, 'claude-code-sessions', entry.name)))
            for (const name of fs.readdirSync(join(root, 'claude-code-sessions', entry.name, org)))
              if (name.startsWith('local_') && name.endsWith('.json'))
                last = Math.max(last, fs.statSync(join(root, 'claude-code-sessions', entry.name, org, name)).mtimeMs)
          return { accountUuid: entry.name, lastSeenAt: new Date(last).toISOString() }
        }))
      let active = 0, peak = 0
      const counts = { readdir: 0, stat: 0 }
      const faults = { readdir: null, stat: null }
      const original = { readdir: fsp.readdir, stat: fsp.stat }
      for (const kind of ['readdir', 'stat']) spyOn(fsp, kind).mockImplementation(async (path, ...args) => {
        counts[kind]++; active++; peak = Math.max(peak, active)
        try {
          await Bun.sleep(1)
          if (faults[kind] !== null && normalizePath(faults[kind]) === normalizePath(String(path)))
            throw new Error('Synthetic ' + kind + ' failure')
          return await original[kind](path, ...args)
        } finally { active-- }
      })
      async function occupy() {
        const gate = Promise.withResolvers()
        let entered = 0
        const holds = Array.from({ length: 8 }, () => fsSlot(async () => { entered++; await gate.promise }))
        while (entered !== 8) await Bun.sleep(0)
        return { release: () => gate.resolve(), holds }
      }
      const occupied = await occupy()
      const scans = Promise.all(roots.map(root => readPastLogins(root)))
      await Bun.sleep(10)
      const before = counts.readdir + counts.stat
      occupied.release()
      const got = await scans
      await Promise.all(occupied.holds)
      const firstCounts = { ...counts }
      const exact = JSON.stringify(got) === JSON.stringify(expected)
      assert(exact, 'Quota changed result values or directory order')
      const root = roots[0], account = uuid(0)
      const accountDir = join(root, 'claude-code-sessions', account)
      const orgDir = join(accountDir, 'org-1')
      const latest = join(orgDir, 'local_3.json')
      let recoveries = 0
      for (const [kind, path, expectedLast] of [
        ['readdir', join(root, 'claude-code-sessions'), 'empty'],
        ['readdir', accountDir, null],
        ['readdir', orgDir, new Date(fs.statSync(join(accountDir, 'org-0', 'local_3.json')).mtimeMs).toISOString()],
        ['stat', latest, new Date(fs.statSync(join(orgDir, 'local_2.json')).mtimeMs).toISOString()],
      ]) {
        faults[kind] = path
        const failed = await readPastLogins(root)
        if (expectedLast === 'empty') assert(failed.length === 0, 'Failed root listing must stay empty')
        else {
          assert(failed.find(row => row.accountUuid === account)?.lastSeenAt === expectedLast, 'Failure changed null/skip semantics')
          assert(failed.filter(row => row.accountUuid !== account).length === 2, 'Failure hid unrelated accounts')
        }
        faults[kind] = null
        assert(JSON.stringify(await readPastLogins(root)) === JSON.stringify(expected[0]), 'Failed listing/stat was cached or leaked quota')
        recoveries++
      }
      const held = await occupy()
      let quotaRecovery = 0
      const later = Array.from({ length: 24 }, () => fsSlot(async () => { quotaRecovery++ }))
      await Bun.sleep(5)
      assert(quotaRecovery === 0, 'External quota is not completely occupied')
      held.release()
      await Promise.all([...held.holds, ...later])
      console.log(JSON.stringify({ before, peak, active, firstCounts, exact, recoveries, quotaRecovery }))
    `
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'roaming'),
        LOCALAPPDATA: join(home, 'local'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEX_HOME: join(home, '.codex'),
        HSWARM_HOME: join(home, '.hswarm'),
        CCMANAGERUI_HOME: join(home, 'data'),
        AGENTHYDRA_HOME: home,
        AGENTHYDRA_DATA_DIR: join(home, 'data'),
        AGENTHYDRA_DB: join(home, 'data', 'test.db'),
        AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
        AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
        AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 25_000,
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`Owned login-history fixture failed: ${err || out}`)
    const result = JSON.parse(out.trim().split('\n').at(-1)!) as Result
    expect(result.before).toBe(0)
    expect(result.peak).toBe(8)
    expect(result.active).toBe(0)
    expect(result.firstCounts).toEqual({ readdir: 160, stat: 384 })
    expect(result.exact).toBe(true)
    expect(result.recoveries).toBe(4)
    expect(result.quotaRecovery).toBe(24)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleURL = (name: string) => pathToFileURL(resolve(import.meta.dir, '../src', name)).href

function removeScratch(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'EBUSY' && code !== 'EPERM') throw error
  }
}

async function child<T>(body: string): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'ah-transcript-warm-stat-'))
  mkdirSync(join(home, 'data'))
  try {
    const program = `
      const { spyOn } = await import('bun:test')
      const fs = await import('node:fs')
      const fsp = await import('node:fs/promises')
      const { join, dirname } = await import('node:path')
      const home = ${JSON.stringify(home)}
      const root = join(home, '.claude', 'projects')
      const fork = join(home, '.openclaude', 'projects')
      const catalog = await import(${JSON.stringify(moduleURL('agent-catalog.ts'))})
      // None of the inherited catalog overrides may reach a real provider's history.
      for (const tool of catalog.AGENT_TOOLS)
        if (tool.envVar) process.env[tool.envVar] = join(home, 'absent-' + tool.id)
      process.env.OPENCLAUDE_PROJECTS_DIR = fork
      const pool = await import(${JSON.stringify(moduleURL('core/map-pool.ts'))})
      const actualPool = pool.mapPool
      let callbacks = 0
      spyOn(pool, 'mapPool').mockImplementation((items, width, fn) => actualPool(items, width, async item => {
        const rel = typeof item === 'string' ? item : item?.rel
        if (typeof rel === 'string' && rel.endsWith('.jsonl')) callbacks++
        return fn(item)
      }))
      let stats = 0
      let peak = 0
      let active = 0
      let vanish = ''
      let delays = false
      const actualStat = fsp.stat
      spyOn(fsp, 'stat').mockImplementation(async (path, ...args) => {
        const target = String(path)
        if (!target.startsWith(home) || !target.endsWith('.jsonl')) return actualStat(path, ...args)
        stats++
        active++
        peak = Math.max(peak, active)
        try {
          if (target === vanish) { fs.rmSync(target); vanish = '' }
          if (delays) await Bun.sleep(target.endsWith('hot.jsonl') ? 8 : 1)
          return await actualStat(path, ...args)
        } finally { active-- }
      })
      const t = await import(${JSON.stringify(moduleURL('transcript.ts'))})
      const quietAt = new Date(Date.now() - 2 * 3600_000)
      function write(path, body = '{}\\n', quiet = true) {
        fs.mkdirSync(dirname(path), { recursive: true })
        fs.writeFileSync(path, body)
        if (quiet) fs.utimesSync(path, quietAt, quietAt)
        return path
      }
      const resetCounts = () => { callbacks = 0; stats = 0; peak = 0 }
      const counts = () => ({ callbacks, stats, peak })
      ${body}
    `
    const proc = Bun.spawn([process.execPath, '-e', program], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        HSWARM_HOME: join(home, '.hswarm'),
        AGENTHYDRA_HOME: join(home, '.agenthydra'),
        AGENTHYDRA_DATA_DIR: join(home, 'data'),
        AGENTHYDRA_DB: join(home, 'data', 'test.db'),
        AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
        AGENTHYDRA_OPENCODE_DB: join(home, 'absent-opencode.db'),
        AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 25_000,
      windowsHide: true,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const line = stdout.split('\n').find((line) => line.startsWith('@@claude-scan@@'))
    if (code !== 0 || !line)
      throw new Error(`Scratch transcript scan failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(line.slice('@@claude-scan@@'.length)) as T
  } finally {
    removeScratch(home)
  }
}

test('warm quiet history avoids stat callbacks and filesystem stats while retaining every parent and child', async () => {
  const result = await child<{
    cold: { callbacks: number; stats: number; peak: number }
    warm: { callbacks: number; stats: number; peak: number }
    equal: boolean
    children: number
    rows: number
  }>(`
    write(join(root, 'project', 'parent.jsonl'))
    for (let i = 0; i < 512; i++)
      write(join(root, 'project', 'parent', 'subagents', 'agent-' + i + '.jsonl'))
    const first = await t.ensureTranscriptIndex(true)
    const cold = counts()
    resetCounts()
    const next = await t.ensureTranscriptIndex(true)
    console.log('@@claude-scan@@' + JSON.stringify({ cold, warm: counts(),
      equal: JSON.stringify(first) === JSON.stringify(next), rows: next.length,
      children: next.find(f => f.session_id === 'parent').siblingPaths.length }))
  `)
  expect(result.cold.callbacks).toBe(513)
  expect(result.cold.stats).toBe(513)
  expect(result.cold.peak).toBeGreaterThan(1)
  expect(result.cold.peak).toBeLessThanOrEqual(6)
  expect(result.warm).toEqual({ callbacks: 0, stats: 0, peak: 0 })
  expect(result.equal).toBe(true)
  expect(result.rows).toBe(1)
  expect(result.children).toBe(512)
}, 30_000)

test('hot growth, additions, deletions and stat races keep scan ordering and recover on the next sweep', async () => {
  const result = await child<{
    changed: { callbacks: number; stats: number; peak: number }
    sizes: Record<string, number>
    equalToSync: boolean
    recovery: { callbacks: number; stats: number; peak: number }
    recovered: boolean
    full: { callbacks: number; stats: number; peak: number }
  }>(`
    const quiet = write(join(root, 'project', 'quiet.jsonl'))
    const hot = write(join(root, 'project', 'hot.jsonl'), '{}\\n', false)
    const gone = write(join(root, 'project', 'gone.jsonl'))
    await t.ensureTranscriptIndex(true)
    fs.appendFileSync(quiet, '{}\\n')
    fs.utimesSync(quiet, quietAt, quietAt)
    fs.appendFileSync(hot, '{}\\n')
    fs.rmSync(gone)
    write(join(root, 'project', 'new.jsonl'), '{}\\n', false)
    vanish = write(join(root, 'project', 'race.jsonl'), '{}\\n', false)
    delays = true
    resetCounts()
    const next = await t.ensureTranscriptIndex(true)
    const changed = counts()
    const sizes = Object.fromEntries(next.map(f => [f.session_id, f.size_bytes]))
    // The established cold policy still trusts the quiet file until a full restat.
    const synced = t.listTranscriptFiles(true)
    const normalize = rows => rows.map(f => ({ ...f, size_bytes: f.session_id === 'quiet' ? 3 : f.size_bytes }))
    const equalToSync = JSON.stringify(next) === JSON.stringify(normalize(synced))
    write(join(root, 'project', 'race.jsonl'), '{}\\n', false)
    resetCounts()
    const repaired = await t.ensureTranscriptIndex(true)
    const recovery = counts()
    t.resetClaudeStatCache()
    resetCounts()
    await t.ensureTranscriptIndex(true)
    console.log('@@claude-scan@@' + JSON.stringify({ changed, sizes, equalToSync, recovery,
      recovered: repaired.some(f => f.session_id === 'race'), full: counts() }))
  `)
  expect(result.changed.callbacks).toBe(3)
  expect(result.changed.stats).toBe(3)
  expect(result.changed.peak).toBeLessThanOrEqual(6)
  expect(result.sizes).toEqual({ quiet: 3, hot: 6, new: 3 })
  expect(result.equalToSync).toBe(true)
  expect(result.recovery.callbacks).toBe(3)
  expect(result.recovery.stats).toBe(3)
  expect(result.recovered).toBe(true)
  expect(result.full.callbacks).toBe(4)
  expect(result.full.stats).toBe(4)
}, 30_000)

test('identical relative paths in different Claude stores retain separate cached stats and identities', async () => {
  const result = await child<{
    cold: { callbacks: number; stats: number; peak: number }
    warm: { callbacks: number; stats: number; peak: number }
    full: { callbacks: number; stats: number; peak: number }
    sizes: Record<string, number>
    warmEqual: boolean
  }>(`
    write(join(root, 'project', 'shared.jsonl'))
    write(join(fork, 'project', 'shared.jsonl'), '{}\\n{}\\n')
    const first = await t.ensureTranscriptIndex(true)
    const cold = counts()
    resetCounts()
    const next = await t.ensureTranscriptIndex(true)
    const warm = counts()
    t.resetClaudeStatCache()
    resetCounts()
    const full = await t.ensureTranscriptIndex(true)
    console.log('@@claude-scan@@' + JSON.stringify({ cold, warm, full: counts(),
      warmEqual: JSON.stringify(first) === JSON.stringify(next),
      sizes: Object.fromEntries(full.map(f => [f.tool, f.size_bytes])) }))
  `)
  expect(result.cold.callbacks).toBe(2)
  expect(result.cold.stats).toBe(2)
  expect(result.warm).toEqual({ callbacks: 0, stats: 0, peak: 0 })
  expect(result.full.callbacks).toBe(2)
  expect(result.full.stats).toBe(2)
  expect(result.warmEqual).toBe(true)
  expect(result.sizes).toEqual({ 'claude-code': 3, openclaude: 6 })
}, 30_000)

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
    if (!['EBUSY', 'EPERM'].includes((error as { code?: string }).code ?? '')) throw error
  }
}

async function child<T>(body: string): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'ah-transcript-folder-paths-'))
  mkdirSync(join(home, 'data'))
  try {
    const program = `
      import { spyOn } from 'bun:test'
      import * as fs from 'node:fs'
      import * as fsp from 'node:fs/promises'
      import * as path from 'node:path'
      const home = ${JSON.stringify(home)}
      const root = path.join(home, '.claude', 'projects')
      const fork = path.join(home, '.openclaude', 'projects')
      const catalog = await import(${JSON.stringify(moduleURL('agent-catalog.ts'))})
      for (const tool of catalog.AGENT_TOOLS)
        if (tool.envVar) process.env[tool.envVar] = path.join(home, 'absent-' + tool.id)
      process.env.OPENCLAUDE_PROJECTS_DIR = fork
      const quiet = new Date(Date.now() - 2 * 3600_000)
      function write(file, body = '{}\\n', cold = true) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        if (cold) fs.utimesSync(file, quiet, quiet)
        return file
      }
      function quietDirs(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
          if (entry.isDirectory()) quietDirs(path.join(dir, entry.name))
        fs.utimesSync(dir, quiet, quiet)
      }
      const actualJoin = path.join
      let joins = 0, fileStats = 0, folderStats = 0
      spyOn(path, 'join').mockImplementation((...parts) => {
        if ([root, fork].includes(parts[0]) && parts.length === 2 && parts[1].endsWith('.jsonl')) joins++
        return actualJoin(...parts)
      })
      const actualStat = fsp.stat
      spyOn(fsp, 'stat').mockImplementation((file, ...args) => {
        if (String(file).startsWith(root)) {
          if (String(file).endsWith('.jsonl')) fileStats++
          else folderStats++
        }
        return actualStat(file, ...args)
      })
      const reset = () => { joins = 0; fileStats = 0; folderStats = 0 }
      const counts = () => ({ joins, fileStats, folderStats })
      const normalize = rows => rows.map(row => ({ ...row,
        ...(row.siblingPaths ? { siblingPaths: [...row.siblingPaths].sort() } : {})
      })).sort((a,b) => a.path.localeCompare(b.path))
      const importTranscript = () => import(${JSON.stringify(moduleURL('transcript.ts'))})
      const tree = await import(${JSON.stringify(moduleURL('core/folder-tree.ts'))})
      ${body}
    `
    const proc = Bun.spawn([process.execPath, '-e', program], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, '.codex'),
        HSWARM_HOME: join(home, '.hswarm'),
        AGENTHYDRA_HOME: join(home, '.agenthydra'),
        AGENTHYDRA_DATA_DIR: join(home, 'data'),
        AGENTHYDRA_DB: join(home, 'data', 'test.db'),
        AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
        AGENTHYDRA_OPENCODE_DB: join(home, 'absent-opencode.db'),
        AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
        AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 25_000,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const line = stdout.split('\n').find((line) => line.startsWith('@@folder-path-cache@@'))
    if (code !== 0 || !line)
      throw new Error(`Scratch folder path cache failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(line.slice('@@folder-path-cache@@'.length)) as T
  } finally {
    removeScratch(home)
  }
}

test('cached folder paths avoid warm normalization while retaining stats, relists and changed filename indices', async () => {
  const result = await child<{
    coldJoins: number
    warm: { joins: number; fileStats: number; folderStats: number }
    full: { joins: number; fileStats: number; folderStats: number }
    relistJoins: number
    changedJoins: number
    warmParity: boolean
    relistParity: boolean
    changedParity: boolean
    changedParent: { size: number; children: string[] }
    oldPathsAbsent: boolean
    freshPresent: boolean
  }>(`
    const parent = write(path.join(root, 'project', 'parent.jsonl'), '{}\\n', false)
    const firstChild = write(path.join(root, 'project', 'parent', 'subagents', 'agent-a.jsonl'))
    write(path.join(root, 'project', 'parent', 'subagents', 'agent-b.jsonl'))
    write(path.join(root, 'project', 'missing', 'subagents', 'agent-orphan.jsonl'))
    const unicode = write(path.join(root, 'project-中文', 'unicode.jsonl'))
    write(path.join(root, 'project', 'ignored.txt'))
    write(path.join(fork, 'project', 'parent.jsonl'), '{}\\n{}\\n')
    quietDirs(root); quietDirs(fork)
    const t = await importTranscript()
    reset()
    const first = await t.ensureTranscriptIndex(true)
    const coldJoins = joins
    reset()
    const warmRows = await t.ensureTranscriptIndex(true)
    const warm = counts()
    t.resetClaudeStatCache()
    reset()
    await t.ensureTranscriptIndex(true)
    const full = counts()
    // An explicit full directory relist creates new Folder identities even with unchanged names.
    await tree.walkFolderTree(root, { relist: true })
    reset()
    const relisted = await t.ensureTranscriptIndex(true)
    const relistJoins = joins
    fs.appendFileSync(parent, '{}\\n')
    fs.rmSync(firstChild)
    write(path.join(root, 'project', 'parent', 'subagents', 'agent-z.jsonl'))
    fs.renameSync(unicode, path.join(root, 'project-中文', 'renamed.jsonl'))
    write(path.join(root, 'fresh', 'new.jsonl'))
    reset()
    const changed = await t.ensureTranscriptIndex(true)
    const changedJoins = joins
    const expected = t.listTranscriptFiles(true)
    const p = changed.find(row => row.tool === 'claude-code' && row.session_id === 'parent')
    console.log('@@folder-path-cache@@' + JSON.stringify({ coldJoins, warm, full, relistJoins, changedJoins,
      warmParity: JSON.stringify(normalize(first)) === JSON.stringify(normalize(warmRows)),
      relistParity: JSON.stringify(normalize(first)) === JSON.stringify(normalize(relisted)),
      changedParity: JSON.stringify(normalize(changed)) === JSON.stringify(normalize(expected)),
      changedParent: { size: p.size_bytes, children: p.siblingPaths.map(file => path.basename(file)).sort() },
      oldPathsAbsent: !changed.some(row => row.path === unicode || row.siblingPaths?.includes(firstChild)),
      freshPresent: changed.some(row => row.session_id === 'new') }))
  `)
  expect(result.coldJoins).toBe(6)
  expect(result.warm.joins).toBe(0)
  expect(result.warm.fileStats).toBe(1)
  expect(result.warm.folderStats).toBeGreaterThan(0)
  expect(result.full.joins).toBe(0)
  expect(result.full.fileStats).toBe(5)
  expect(result.full.folderStats).toBeGreaterThan(0)
  expect(result.relistJoins).toBe(5)
  expect(result.changedJoins).toBe(4)
  expect(result.warmParity).toBe(true)
  expect(result.relistParity).toBe(true)
  expect(result.changedParity).toBe(true)
  expect(result.changedParent).toEqual({ size: 6, children: ['agent-b.jsonl', 'agent-z.jsonl'] })
  expect(result.oldPathsAbsent).toBe(true)
  expect(result.freshPresent).toBe(true)
}, 30_000)

test('a same-mtime-tick directory change invalidates cached paths on the next sweep', async () => {
  const result = await child<{ before: string[]; after: string[]; joins: number }>(`
    const dir = path.join(root, 'racy')
    write(path.join(dir, 'a.jsonl'))
    const t = await importTranscript()
    const tick = Math.floor(Date.now() / 1000)
    fs.utimesSync(dir, tick, tick)
    const before = await t.ensureTranscriptIndex(true)
    write(path.join(dir, 'b.jsonl'))
    fs.utimesSync(dir, tick, tick)
    reset()
    const after = await t.ensureTranscriptIndex(true)
    console.log('@@folder-path-cache@@' + JSON.stringify({
      before: before.map(row => row.session_id).sort(), after: after.map(row => row.session_id).sort(), joins }))
  `)
  expect(result.before).toEqual(['a'])
  expect(result.after).toEqual(['a', 'b'])
  expect(result.joins).toBe(2)
}, 30_000)

test('non-recursive glob fallback and later pattern changes preserve matched paths', async () => {
  const result = await child<{
    coldJoins: number
    warmJoins: number
    fallbackParity: boolean
    fallbackIds: string[]
    narrowedIds: string[]
    expandedIds: string[]
    expandedJoins: number
  }>(`
    const tool = catalog.AGENT_TOOLS.find(tool => tool.id === 'openclaude')
    tool.glob = 'project/*.jsonl'
    write(path.join(fork, 'project', 'top.jsonl'))
    write(path.join(fork, 'nested', 'audit-match.jsonl'))
    write(path.join(fork, 'nested', 'other.jsonl'))
    quietDirs(fork)
    const t = await importTranscript()
    reset()
    const first = await t.ensureTranscriptIndex(true)
    const coldJoins = joins
    reset()
    const next = await t.ensureTranscriptIndex(true)
    const warmJoins = joins
    tool.glob = '**/audit-*.jsonl'
    const narrowed = await t.ensureTranscriptIndex(true)
    tool.glob = '**/*.jsonl'
    reset()
    const expanded = await t.ensureTranscriptIndex(true)
    console.log('@@folder-path-cache@@' + JSON.stringify({ coldJoins, warmJoins,
      fallbackParity: JSON.stringify(normalize(first)) === JSON.stringify(normalize(next)),
      fallbackIds: first.map(row => row.session_id).sort(),
      narrowedIds: narrowed.map(row => row.session_id).sort(),
      expandedIds: expanded.map(row => row.session_id).sort(), expandedJoins: joins }))
  `)
  expect(result.coldJoins).toBe(1)
  expect(result.warmJoins).toBe(1)
  expect(result.fallbackParity).toBe(true)
  expect(result.fallbackIds).toEqual(['top'])
  expect(result.narrowedIds).toEqual(['audit-match'])
  expect(result.expandedIds).toEqual(['audit-match', 'other', 'top'])
  expect(result.expandedJoins).toBe(2)
}, 30_000)

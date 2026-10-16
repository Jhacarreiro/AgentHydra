import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function removeScratch(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    if (!['EBUSY', 'EPERM'].includes((error as { code?: string }).code ?? '')) throw error
  }
}

test('async transcript sweeps normalize each path once and retain sync metadata for parents, children and orphans', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-transcript-path-reuse-'))
  const moduleURL = (name: string) => pathToFileURL(resolve(import.meta.dir, '../src', name)).href
  mkdirSync(join(home, 'data'))
  try {
    const program = `
      import { spyOn } from 'bun:test'
      import * as fs from 'node:fs'
      import * as path from 'node:path'
      const home = ${JSON.stringify(home)}
      const root = path.join(home, '.claude', 'projects')
      const fork = path.join(home, '.openclaude', 'projects')
      const cowork = path.join(home, 'cowork')
      const catalog = await import(${JSON.stringify(moduleURL('agent-catalog.ts'))})
      for (const tool of catalog.AGENT_TOOLS)
        if (tool.envVar) process.env[tool.envVar] = path.join(home, 'absent-' + tool.id)
      process.env.OPENCLAUDE_PROJECTS_DIR = fork
      process.env.COWORK_DIR = cowork
      const quiet = new Date(Date.now() - 2 * 3600_000)
      function write(file, body = '{}\\n', cold = true) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        if (cold) fs.utimesSync(file, quiet, quiet)
      }
      const top = path.join(root, 'project with spaces', 'parent.jsonl')
      const child = path.join(root, 'project with spaces', 'parent', 'subagents', 'agent-child.jsonl')
      const orphan = path.join(root, 'project with spaces', 'absent-parent', 'subagents', 'agent-orphan.jsonl')
      const unicode = path.join(root, 'project-\\u4e2d\\u6587', 'standalone.jsonl')
      const other = path.join(fork, 'project with spaces', 'fork-parent.jsonl')
      const audit = path.join(cowork, 'outer', 'inner', 'local_run', 'audit.jsonl')
      const sandbox = path.join(cowork, 'outer', 'inner', 'local_run', '.claude', 'projects', 'p', 'sandbox.jsonl')
      const lost = path.join(cowork, 'outer', 'inner', 'local_orphan', '.claude', 'projects', 'p', 'lost.jsonl')
      write(top, '{}\\n', false)
      for (const file of [child, orphan, unicode]) write(file)
      for (const file of [audit, sandbox, lost]) write(file)
      write(other, '{}\\n{}\\n')
      const actualJoin = path.join
      let joins = 0
      spyOn(path, 'join').mockImplementation((...parts) => {
        if ([root, fork, cowork].includes(parts[0]) && parts.length === 2 && parts[1].endsWith('.jsonl')) joins++
        return actualJoin(...parts)
      })
      const transcript = await import(${JSON.stringify(moduleURL('transcript.ts'))})
      const normalize = rows => rows.map(row => ({ ...row,
        ...(row.siblingPaths ? { siblingPaths: [...row.siblingPaths].sort() } : {})
      })).sort((a,b) => a.path.localeCompare(b.path))
      const reset = () => { joins = 0 }
      reset()
      const cold = await transcript.ensureTranscriptIndex(true)
      const coldJoins = joins
      reset()
      const warm = await transcript.ensureTranscriptIndex(true)
      const warmJoins = joins
      reset()
      const sync = transcript.listTranscriptFiles(true)
      const syncJoins = joins
      const added = path.join(root, 'project with spaces', 'new.jsonl')
      fs.appendFileSync(top, '{}\\n')
      fs.utimesSync(top, new Date(), new Date())
      fs.rmSync(unicode)
      write(added, '{}\\n{}\\n{}\\n', false)
      reset()
      const changed = await transcript.ensureTranscriptIndex(true)
      const changedJoins = joins
      const expectedChanged = transcript.listTranscriptFiles(true)
      console.log('@@path-reuse@@' + JSON.stringify({ coldJoins, warmJoins, syncJoins, changedJoins,
        coldWarmParity: JSON.stringify(normalize(cold)) === JSON.stringify(normalize(warm)),
        asyncSyncParity: JSON.stringify(normalize(cold)) === JSON.stringify(normalize(sync)),
        changedParity: JSON.stringify(normalize(changed)) === JSON.stringify(normalize(expectedChanged)),
        records: cold.map(row => ({ id: row.session_id, tool: row.tool, project: row.project,
          size: row.size_bytes, children: row.siblingPaths?.length ?? 0 })),
        changed: changed.map(row => ({ id: row.session_id, size: row.size_bytes })) }))
    `
    const child = Bun.spawn([process.execPath, '-e', program], {
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
      },
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 25_000,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const line = stdout.split('\n').find((line) => line.startsWith('@@path-reuse@@'))
    if (code !== 0 || !line)
      throw new Error(`Scratch path reuse failed (${code}): ${stderr}\n${stdout}`)
    const result = JSON.parse(line.slice('@@path-reuse@@'.length)) as {
      coldJoins: number
      warmJoins: number
      syncJoins: number
      changedJoins: number
      coldWarmParity: boolean
      asyncSyncParity: boolean
      changedParity: boolean
      records: { id: string; tool: string; project: string; size: number; children: number }[]
      changed: { id: string; size: number }[]
    }
    expect(result.coldJoins).toBe(8)
    expect(result.warmJoins).toBe(8)
    expect(result.syncJoins).toBe(16)
    expect(result.changedJoins).toBe(8)
    expect(result.coldWarmParity).toBe(true)
    expect(result.asyncSyncParity).toBe(true)
    expect(result.changedParity).toBe(true)
    expect(result.records).toEqual(
      expect.arrayContaining([
        { id: 'parent', tool: 'claude-code', project: 'project with spaces', size: 3, children: 1 },
        {
          id: 'fork-parent',
          tool: 'openclaude',
          project: 'project with spaces',
          size: 6,
          children: 0,
        },
        {
          id: 'agent-orphan',
          tool: 'claude-code',
          project: 'project with spaces',
          size: 3,
          children: 0,
        },
        { id: 'standalone', tool: 'claude-code', project: 'project-中文', size: 3, children: 0 },
        { id: 'run', tool: 'cowork', project: 'outer', size: 3, children: 1 },
        { id: 'lost', tool: 'cowork', project: 'outer', size: 3, children: 0 },
      ]),
    )
    expect(result.changed).toEqual(
      expect.arrayContaining([
        { id: 'parent', size: 6 },
        { id: 'new', size: 9 },
      ]),
    )
    expect(result.changed.some((row) => row.id === 'standalone')).toBe(false)
  } finally {
    removeScratch(home)
  }
}, 30_000)

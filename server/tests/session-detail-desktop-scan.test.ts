import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = (name: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', name)).href)

interface Result {
  skipped: Array<{
    source: string
    remote: boolean
    equal: boolean
    mapCalls: number
    stats: number
  }>
  local: { mapCalls: number; stats: number; archived: boolean; effort: string; retired: string }
}

test('session details avoid unused desktop scans while local Claude still reads fresh metadata', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-session-detail-desktop-'))
  mkdirSync(join(home, 'data'))
  try {
    const program = `
      import { spyOn } from 'bun:test'
      import * as fs from 'node:fs'
      import { join } from 'node:path'
      const home = ${JSON.stringify(home)}
      const localId = '00000000-0000-4000-8000-000000000001'
      const metadataDir = join(home, '.claude-instances', 'example-profile', 'claude-code-sessions', 'account', 'org')
      fs.mkdirSync(metadataDir, { recursive: true })
      const localPath = join(metadataDir, 'local_' + localId + '.json')
      const localRecord = { cliSessionId: localId, isArchived: false, effort: 'medium', priorCliSessionIds: ['example-retired-id'] }
      for (let i = 0; i < 32; i++) {
        const id = i === 0 ? localId : 'example-desktop-' + i
        fs.writeFileSync(join(metadataDir, 'local_' + id + '.json'), JSON.stringify(i === 0 ? localRecord : { cliSessionId: id, isArchived: false }))
      }
      const claudeLine = (role, text) => JSON.stringify({ type: role, timestamp: '2026-01-01T10:00:00.000Z', cwd: 'D:\\\\example', message: { role, content: text } }) + '\\n'
      const codexLine = (type, payload) => JSON.stringify({ type, timestamp: '2026-01-01T10:00:00.000Z', payload }) + '\\n'
      const transcript = (id, source, remote = false) => {
        const path = join(home, id + '.jsonl')
        const body = source === 'codex'
          ? codexLine('session_meta', { id, cwd: 'D:\\\\example', timestamp: '2026-01-01T10:00:00.000Z' }) + codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Example question' }] }) + codexLine('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Example response' }] })
          : claudeLine('user', 'Example question') + claudeLine('assistant', 'Example response')
        fs.writeFileSync(path, body)
        const st = fs.statSync(path)
        return { session_id: id, source, path, project: 'D--example', mtime_ms: st.mtimeMs, size_bytes: st.size, archived: false, remote,
          ...(source === 'codex' ? { instance: { name: 'example-codex', ref: 'codex:example-codex', num: 7 } } : {}) }
      }
      const cases = [transcript('example-codex-session', 'codex'), transcript('example-remote-session', 'claude', true)]
      const local = transcript(localId, 'claude')
      const index = await import(${source('transcript.ts')})
      let selected = local
      spyOn(index, 'findTranscriptAsync').mockImplementation(async () => selected)
      spyOn(index, 'ensureTranscriptIndex').mockImplementation(async () => [selected])
      spyOn(index, 'listTranscriptFiles').mockImplementation(() => [selected])
      const desktop = await import(${source('instance-sessions.ts')})
      const originalMap = desktop.sessionMetaMap
      let mapCalls = 0, stats = 0
      spyOn(desktop, 'sessionMetaMap').mockImplementation(() => { mapCalls++; return originalMap() })
      const originalStat = fs.statSync
      spyOn(fs, 'statSync').mockImplementation((path, ...args) => {
        if (String(path).includes('claude-code-sessions')) stats++
        return originalStat(path, ...args)
      })
      const { getSession } = await import(${source('sessions.ts')})
      const skipped = []
      for (const tf of cases) {
        selected = tf
        originalMap()
        const expected = await getSession(tf.session_id, tf.source)
        desktop.invalidateSessionMetaCache()
        mapCalls = stats = 0
        const got = await getSession(tf.session_id, tf.source)
        skipped.push({ source: tf.source, remote: tf.remote, equal: got !== null && JSON.stringify(got) === JSON.stringify(expected), mapCalls, stats })
      }
      // A local desktop detail still has to see the new archive/effort and lineage after invalidation.
      selected = local
      fs.writeFileSync(localPath, JSON.stringify({ ...localRecord, isArchived: true, effort: 'high' }))
      desktop.invalidateSessionMetaCache()
      mapCalls = stats = 0
      const got = await getSession(local.session_id, 'claude')
      const retired = desktop.retiredSessionIds().get('example-retired-id')
      console.log(JSON.stringify({ skipped, local: { mapCalls, stats, archived: got?.archived, effort: got?.effort, retired } }))
    `
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'appdata'),
        LOCALAPPDATA: join(home, 'localappdata'),
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
    if (code !== 0) throw new Error(`Owned detail fixture failed: ${err || out}`)
    const result = JSON.parse(out.trim().split('\n').at(-1)!) as Result
    expect(result.skipped).toEqual([
      { source: 'codex', remote: false, equal: true, mapCalls: 0, stats: 0 },
      { source: 'claude', remote: true, equal: true, mapCalls: 0, stats: 0 },
    ])
    expect(result.local).toEqual({
      mapCalls: 1,
      stats: 32,
      archived: true,
      effort: 'high',
      retired: '00000000-0000-4000-8000-000000000001',
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

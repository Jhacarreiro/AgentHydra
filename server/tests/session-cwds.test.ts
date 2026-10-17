// server/tests/session-cwds.test.ts - the sessions the stored tables never saw get their cwd from their
// own files, so the "Cost by project" card stops filing them under "unknown".
//
// THE FAILURE THIS PINS. The card placed a session only through session_stats and session_scan_cache.
// CliMayte's config folders, HSwarm's jobs and most Codex rollouts (a sub-agent's under its parent's id,
// a packed one only in a zip) are in neither, and every Codex row there has the cwd "codex": on the
// owner's PC $57.9K grouped under "unknown" and $20.2K under a project named "codex". Here each source
// names the cwd itself; a file is read once, and the card groups the cwd by repository. Every file is
// built in a scratch folder.

import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { resetSessionProjects, spendReport } from '../src/analytics'
import { db } from '../src/db'
import { KitStore, type UsageEventInput } from '../src/kit/store'
import { resetRepoCache } from '../src/project-repo'
import { learnedSessionCwds, learnSessionCwds, transcriptSession } from '../src/session-cwds'

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)
const root = mkdtempSync(join(tmpdir(), 'ah-session-cwds-'))
const store = new KitStore(':memory:', { now: NOW })
afterAll(() => {
  store.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A checkout with an origin remote. */
const repo = join(root, 'work', 'widget')
mkdirSync(join(repo, '.git'), { recursive: true })
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(
  join(repo, '.git', 'config'),
  '[remote "origin"]\n\turl = https://github.com/example-owner/widget.git\n',
)
/** A folder in no repository. */
const plain = join(root, 'work', 'loose')
mkdirSync(plain, { recursive: true })

const jsonl = (...lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`

/** A zip of deflated entries, the way Codex packs a month of archived rollouts. */
function writeZip(path: string, files: Array<[name: string, text: string]>): void {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const body = Buffer.from(text)
    const packed = deflateRawSync(body)
    const nameBytes = Buffer.from(name)
    const crc = Bun.hash.crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(body.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, packed)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(path, Buffer.concat([...locals, dir, end]))
}

/** A file the ledger read: the kit's cursor names it. */
const cursor = (path: string) => store.setCursor({ path, size: 1, mtime: 1, offset: 1, version: 1 })

// CliMayte: a config folder's transcript, whose first line names no cwd, and a sub-agent's under it.
const projectDir = join(root, 'cli-instances', 'acct-1', 'projects', 'C--Users-me-widget')
const cmMain = join(projectDir, 'cm-1.jsonl')
const cmSub = join(projectDir, 'cm-2', 'subagents', 'agent-a1.jsonl')
const cmKnown = join(projectDir, 'known-1.jsonl')
const cmEmpty = join(projectDir, 'cm-empty.jsonl')
mkdirSync(join(projectDir, 'cm-2', 'subagents'), { recursive: true })
writeFileSync(
  cmMain,
  jsonl({ type: 'queue-operation' }, { type: 'user', sessionId: 'cm-1', cwd: join(repo, 'src') }),
)
writeFileSync(cmSub, jsonl({ type: 'user', sessionId: 'cm-2', cwd: plain }))
writeFileSync(cmKnown, jsonl({ type: 'user', sessionId: 'known-1', cwd: plain }))
writeFileSync(cmEmpty, jsonl({ type: 'queue-operation' }))

// Codex: a loose sub-agent rollout keyed to its parent's session, and one that lives only in a zip.
const sessions = join(root, 'codex', 'sessions')
const packedDir = join(root, 'codex', 'archived_sessions', '_packed')
mkdirSync(sessions, { recursive: true })
mkdirSync(packedDir, { recursive: true })
const loose = join(
  sessions,
  'rollout-2026-06-01T00-00-00-0190aaaa-0000-7000-8000-000000000001.jsonl',
)
writeFileSync(
  loose,
  jsonl(
    { type: 'session_meta', payload: { id: 'sub-1', session_id: 'cx-parent', cwd: plain } },
    { type: 'turn_context', payload: { model: 'gpt-5' } },
  ),
)
const zip = join(packedDir, 'codex-sessions-2026-05.zip')
const entry = 'rollout-2026-05-01T00-00-00-0190bbbb-0000-7000-8000-000000000002.jsonl'
writeZip(zip, [
  [entry, jsonl({ type: 'session_meta', payload: { id: 'cx-old', cwd: repo } }, { type: 'x' })],
])

// HSwarm: a caller that ran most of its jobs from the repository.
const hswarmDb = join(root, 'hswarm.sqlite')
const hs = new Database(hswarmDb)
hs.exec('create table utilizations (id text primary key, caller_session text, caller_cwd text)')
const job = hs.query('insert into utilizations (id, caller_session, caller_cwd) values (?, ?, ?)')
let jobs = 0
const addJobs = (session: string, cwd: string, n: number) => {
  for (let i = 0; i < n; i++) job.run(`j${++jobs}`, session, cwd)
}
addJobs('hs000001', repo, 3)
addJobs('hs000001', plain, 1)
addJobs('', plain, 2)
hs.close()

const src = { kit: store, hswarmDb }

beforeAll(() => {
  db.query('delete from session_cwd_seen').run()
  db.query('delete from session_cwd_mark').run()
  for (const p of [cmMain, cmSub, cmKnown, cmEmpty, loose, `${zip}!${entry}`]) cursor(p)
  store.setMeta(`ingest_state:${loose}`, JSON.stringify({ session: 'cx-parent', line: 2 }))
  store.setMeta(`ingest_state:${zip}!${entry}`, JSON.stringify({ session: 'cx-old', line: 2 }))
  // Copilot Chat: the ingest keeps each chat's folder in the kit's meta (kit/ingest-copilot.ts).
  store.setMeta('copilot_cwd:cp-1', plain)
  store.setMeta('copilot_cwd:known-1', repo)
})

describe('learning where unplaced sessions ran', () => {
  test("a transcript's session is the ledger's: its file, or the parent of a sub-agent's", () => {
    expect(transcriptSession(cmMain)).toBe('cm-1')
    expect(transcriptSession(cmSub)).toBe('cm-2')
  })

  test('each source names its cwd; a session placed already is not read', async () => {
    const got = await learnSessionCwds(src, new Set(['known-1']), Date.now())
    // cm-empty is new and names no cwd yet: left for a later pass, not marked.
    // HSwarm: one row per caller session and cwd (the session-less jobs place nothing).
    expect(got).toEqual({ claude: 2, codex: 2, copilot: 1, hswarm: 2 })
    const map = await learnedSessionCwds()
    expect(map.get('cp-1')).toBe(plain)
    expect(map.get('cm-1')).toBe(join(repo, 'src'))
    expect(map.get('cm-2')).toBe(plain)
    expect(map.get('cx-parent')).toBe(plain)
    expect(map.get('cx-old')).toBe(repo)
    expect(map.get('hs000001')).toBe(repo)
    expect(map.has('known-1')).toBe(false)
  })

  test('a second pass reads no file again, and counts only the jobs HSwarm ran since', async () => {
    const h = new Database(hswarmDb)
    const more = h.query(
      'insert into utilizations (id, caller_session, caller_cwd) values (?, ?, ?)',
    )
    for (let i = 0; i < 5; i++) more.run(`k${i}`, 'hs000001', plain)
    h.close()
    // Two hours on, the transcript that still names no cwd is marked and left alone.
    expect(await learnSessionCwds(src, new Set(['known-1']), Date.now() + 2 * 3_600_000)).toEqual({
      claude: 1,
      codex: 0,
      copilot: 0,
      hswarm: 1,
    })
    const n = db
      .query<{ n: number }, [string]>(
        "select n from session_cwd_seen where source = 'hswarm' and session_id = 'hs000001' and cwd = ?",
      )
      .get(plain)
    expect(n?.n).toBe(6)
    expect((await learnedSessionCwds()).get('hs000001')).toBe(plain)
    expect(await learnSessionCwds(src, new Set(['known-1']), Date.now() + 2 * 3_600_000)).toEqual({
      claude: 0,
      codex: 0,
      copilot: 0,
      hswarm: 0,
    })
  })
})

describe('the spend report groups learned sessions by repository', () => {
  let n = 0
  const call = (session: string, source: string, usd: number): UsageEventInput => ({
    id: `sc${++n}`,
    ts: NOW - 3_600_000,
    source,
    session,
    model: 'claude-opus-5',
    provider: 'anthropic',
    input: 100,
    output: 50,
    list_usd: usd,
    weighted: 1,
  })

  test('learned cwds fill the gaps, "codex" is no project, and a repository is one row', async () => {
    // Every Codex session in session_stats has the cwd "codex".
    db.query(
      'insert or replace into session_stats (session_key, session_id, source, cwd, project, first_seen_at, last_scanned_at) values (?, ?, ?, ?, ?, 1, 2)',
    ).run('codex:cx-parent', 'cx-parent', 'codex', 'codex', 'codex')
    store.upsertEvents([
      call('cm-1', 'climayte', 4),
      call('cx-old', 'codex', 2),
      call('hs000001', 'hswarm', 1),
      call('cx-parent', 'codex', 8),
      call('nobody', 'cli', 16),
    ])
    resetSessionProjects()
    resetRepoCache()
    const r = await spendReport({ store, now: NOW })
    const rows = Object.fromEntries(r.byProject.map((b) => [b.key, b]))
    // cm-1 ran in a subfolder, cx-old in the checkout itself; hs000001's caller is now mostly elsewhere.
    expect(rows['example-owner/widget']?.costUsd).toBe(6)
    expect(rows['example-owner/widget']?.label).toBe('example-owner/widget')
    expect(rows[plain]?.costUsd).toBe(9)
    expect(rows[plain]?.label).toBeUndefined()
    expect(rows.codex).toBeUndefined()
    expect(rows.unknown?.costUsd).toBe(16)
  })
})

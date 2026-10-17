// server/tests/session-work.test.ts - a session that ran in a folder above the checkouts counts, on the
// "Cost by project" card, as the repository its tool calls worked in.
//
// THE FAILURE THIS PINS. A chat started in a folder holding many repositories has that folder as its cwd,
// which is in no repository, so the card showed the folder: on the owner's PC two such folders held $77.3K
// of $352K. Here a scratch parent folder holds two invented repositories; each session's transcript or
// rollout names the files it touched, and the card credits it to the repository most of them are in.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetSessionProjects, spendReport } from '../src/analytics'
import { db } from '../src/db'
import { KitStore, type UsageEventInput } from '../src/kit/store'
import { resetRepoCache } from '../src/project-repo'
import { learnSessionWork, workedRoots } from '../src/session-work'

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)
const root = mkdtempSync(join(tmpdir(), 'ah-session-work-'))
const store = new KitStore(':memory:', { now: NOW })
afterAll(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The folder the chats were started in, holding two checkouts. */
const parent = join(root, 'work')
const checkout = (name: string) => {
  const dir = join(parent, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, '.git', 'config'),
    `[remote "origin"]\n\turl = https://github.com/example-owner/${name}.git\n`,
  )
  return dir
}
const alpha = checkout('alpha')
const beta = checkout('beta')

const jsonl = (...lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
/** An assistant line calling one tool, in the folder `cwd`. */
const call = (name: string, input: Record<string, unknown>, cwd = parent) => ({
  type: 'assistant',
  cwd,
  message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input }] },
})
/** The tool's answer: no path in it counts. */
const result = (text: string) => ({
  type: 'user',
  cwd: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: 't-x', content: text }] },
})

const projects = join(root, 'cli', 'projects', 'C--Users-me-work')
mkdirSync(projects, { recursive: true })
// Two edits in alpha, a shell call that moved there and a relative search; one read in beta, and one of a
// file in no repository, which counts for nothing.
const mostlyAlpha = join(projects, 'pw-1.jsonl')
writeFileSync(
  mostlyAlpha,
  jsonl(
    { type: 'user', cwd: parent, message: { content: 'go' } },
    call('Edit', { file_path: join(alpha, 'src', 'a.ts') }),
    call('Write', { file_path: join(alpha, 'src', 'b.ts') }),
    result(join(beta, 'src', 'listed-in-an-answer.ts')),
    call('Bash', { command: 'git status' }, alpha),
    call('Grep', { pattern: 'x', path: join('alpha', 'src') }),
    call('Read', { file_path: join(beta, 'README.md') }),
    call('Read', { file_path: join(root, 'notes.txt') }),
  ),
)
// One edit in each: no majority.
const split = join(projects, 'pw-2.jsonl')
writeFileSync(
  split,
  jsonl(
    call('Edit', { file_path: join(alpha, 'src', 'a.ts') }),
    call('Edit', { file_path: join(beta, 'src', 'a.ts') }),
  ),
)
// Ran inside a checkout: placed already, never read.
const inRepo = join(projects, 'pw-3.jsonl')
writeFileSync(inRepo, jsonl(call('Edit', { file_path: join(beta, 'src', 'a.ts') }, alpha)))

// Codex: an exec script's shell call and patch, both in beta, and a relative apply_patch.
const rollout = join(
  root,
  'codex',
  'sessions',
  'rollout-2026-06-01T00-00-00-0190cccc-0000-7000-8000-000000000003.jsonl',
)
mkdirSync(join(root, 'codex', 'sessions'), { recursive: true })
const patch = `*** Begin Patch\n*** Update File: ${join(beta, 'src', 'c.ts')}\n@@\n-a\n+b\n*** End Patch`
writeFileSync(
  rollout,
  jsonl(
    { type: 'session_meta', payload: { id: 'cx-w', cwd: parent } },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: `const r = await tools.shell_command({"command":"git status","workdir":${JSON.stringify(beta)}})\nconst patch = ${JSON.stringify(patch)}`,
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: `*** Begin Patch\n*** Update File: ${join('beta', 'src', 'd.ts')}\n@@\n-a\n+b\n*** End Patch`,
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        arguments: JSON.stringify({ command: 'ls', workdir: alpha }),
      },
    },
  ),
)

/** The ledger read the file to its end. */
const ingested = (path: string) =>
  store.setCursor({
    path,
    size: statSync(path).size,
    mtime: 1,
    offset: statSync(path).size,
    version: 1,
  })

const cwds = new Map([
  ['pw-1', parent],
  ['pw-2', parent],
  ['pw-3', alpha],
  ['cx-w', parent],
])

beforeAll(() => {
  db.query('delete from session_work_read').run()
  db.query('delete from session_work_vote').run()
  for (const p of [mostlyAlpha, split, inRepo, rollout]) ingested(p)
  store.setMeta(`ingest_state:${rollout}`, JSON.stringify({ session: 'cx-w', line: 4 }))
  resetRepoCache()
})

describe('a session in a folder above the checkouts', () => {
  test('counts as the repository most of its tool calls touched, on the spend report', async () => {
    expect(await learnSessionWork(store, cwds)).toBe(3)
    for (const [id, cwd] of cwds)
      db.query(
        'insert or replace into session_stats (session_key, session_id, source, cwd, project, first_seen_at, last_scanned_at) values (?, ?, ?, ?, ?, 1, 2)',
      ).run(`t:${id}`, id, 'cli', cwd, cwd)
    let n = 0
    const spend = (session: string, usd: number): UsageEventInput => ({
      id: `sw${++n}`,
      ts: NOW - 3_600_000,
      source: 'cli',
      session,
      model: 'claude-opus-5',
      provider: 'anthropic',
      input: 100,
      output: 50,
      list_usd: usd,
      weighted: 1,
    })
    store.upsertEvents([spend('pw-1', 4), spend('pw-2', 2), spend('pw-3', 8), spend('cx-w', 1)])
    resetSessionProjects()
    const r = await spendReport({ store, now: NOW })
    const rows = Object.fromEntries(r.byProject.map((b) => [b.key, b.costUsd]))
    // pw-1 (4 of 5 votes alpha) and pw-3 (ran in alpha); cx-w's votes are 3 beta to 1 alpha.
    expect(rows['example-owner/alpha']).toBe(12)
    expect(rows['example-owner/beta']).toBe(1)
    expect(rows[parent]).toBe(2)
  })

  test('a file that grew is read from where the last pass stopped, and one that did not is not read', async () => {
    appendFileSync(
      mostlyAlpha,
      jsonl(
        call('Edit', { file_path: join(beta, 'src', 'e.ts') }),
        call('Edit', { file_path: join(beta, 'src', 'f.ts') }),
        call('Edit', { file_path: join(beta, 'src', 'g.ts') }),
      ),
    )
    // Not yet ingested by the ledger: left for later.
    expect(await learnSessionWork(store, cwds)).toBe(0)
    ingested(mostlyAlpha)
    expect(await learnSessionWork(store, cwds)).toBe(1)
    // Alpha 4, beta 4: no majority now. Had the start been read again, alpha would hold 8 to 4.
    const roots = await workedRoots()
    expect(roots.has('pw-1')).toBe(false)
    expect(roots.get('cx-w')).toBe(beta)
    expect(await learnSessionWork(store, cwds)).toBe(0)
  })
})

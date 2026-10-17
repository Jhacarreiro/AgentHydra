// server/tests/session-search-cli.test.ts — body search over the CLI accounts' own chats, answered from
// the conversation index (server/src/session-search.ts, server/src/cli-transcripts.ts).
//
// Two failures found on 2026-10-17. A CLI account keeps its chats under its own config folder
// (`<CONFIG_DIR>/cli-instances/<id>/projects`), which the search never listed, so a word said in a
// CliMayte chat answered "no hits". And the index answered only when 98% of the files in scope were
// exactly current, so a few running chats and new files made it stand aside for a 7 s scan.
//
// The accounts are real CLI instance records in the test preload's scratch CONFIG_DIR, with invented
// transcripts. The index is a scratch file. Nothing of the developer's is written.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshCliTranscriptFiles } from '../src/cli-transcripts'
import { createCliInstance } from '../src/core/cli-instances'
import {
  dropSearchIndex,
  refreshSearchIndex,
  searchIndexPath,
  setSearchIndexPathForTests,
} from '../src/search-index'
import { searchSessionBodies } from '../src/session-search'

const tag = crypto.randomUUID().slice(0, 8)
const NAME_A = `Example Account A ${tag}`
const NAME_B = `Example Account B ${tag}`
const PROJECT = 'C--Users-me-Example-Project'

function account(name: string): { id: string; dir: string } {
  const made = createCliInstance(name)
  const id = made.data?.id as string
  const dir = made.data?.configDir as string
  return { id, dir }
}
const A = account(NAME_A)
const B = account(NAME_B)

const say = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: role,
    cwd: 'C:\\Users\\me\\Example\\Project',
    timestamp: '2026-10-17T09:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  })

/** A chat in an account's own folder, laid out as Claude Code writes it. */
function chat(dir: string, sessionId: string, lines: string[]): string {
  const folder = join(dir, 'projects', PROJECT)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `${sessionId}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/** The listing and the index over these two accounts' chats only, as the daemon's keeper leaves them. */
async function indexAccounts() {
  const files = (await refreshCliTranscriptFiles()).filter(
    (f) => f.instance?.ref === `cli:${A.id}` || f.instance?.ref === `cli:${B.id}`,
  )
  await refreshSearchIndex(files)
}

const indexPathBefore = searchIndexPath()
beforeAll(() => {
  setSearchIndexPathForTests(join(A.dir, 'search-index.db'))
})
afterAll(() => {
  dropSearchIndex()
  setSearchIndexPathForTests(indexPathBefore)
  for (const d of [A.dir, B.dir]) rmSync(join(d, 'projects'), { recursive: true, force: true })
})

/** Long enough for the first search's sweep of the transcript stores on a machine with real ones. */
const SWEEP_TIMEOUT_MS = 60_000

// A chat moved or relaunched to another account keeps its session id (1,305 ids sat in two or more
// folders on the owner's PC). Same size and mtime here, so only the account tells the copies apart.
test(
  'a CLI account chat is found from the index and names its account, even when another account holds the same session id',
  async () => {
    const shared = crypto.randomUUID()
    const at = new Date('2026-10-17T09:30:00.000Z')
    const pathA = chat(A.dir, shared, [say('user', 'please file the quillfeathera report')])
    const pathB = chat(B.dir, shared, [say('user', 'please file the quillfeatherb report')])
    utimesSync(pathA, at, at)
    utimesSync(pathB, at, at)
    await indexAccounts()

    for (const [name, word, ref] of [
      [NAME_A, 'quillfeathera', `cli:${A.id}`],
      [NAME_B, 'quillfeatherb', `cli:${B.id}`],
    ] as const) {
      const r = await searchSessionBodies({ query: word, instance: name })
      expect(r.searched).toBe('index')
      expect(r.results.map((h) => h.session_id)).toEqual([shared])
      expect(r.results[0]?.store).toBe('cli')
      expect(r.results[0]?.account).toMatchObject({ ref, name })
    }

    // The exhaustive scan reads the same accounts.
    const scanned = await searchSessionBodies({
      query: 'quillfeathera',
      instance: NAME_A,
      mode: 'scan',
    })
    expect(scanned.searched).toBe('scan')
    expect(scanned.results.map((h) => h.session_id)).toEqual([shared])
  },
  SWEEP_TIMEOUT_MS,
)

// Two of three files are not current in the index: one running chat grew, one chat is new. The old rule
// (98% current or nothing) scanned here; the index now answers, and reads only what it does not hold.
test(
  'auto mode answers from the index while chats run and new ones appear, and still finds their new words',
  async () => {
    const running = crypto.randomUUID()
    const runningPath = chat(A.dir, running, [
      say('user', 'start the harbourline migration'),
      say('assistant', 'starting it'),
    ])
    const quiet = crypto.randomUUID()
    chat(A.dir, quiet, [say('user', 'an unrelated quiet chat')])
    await indexAccounts()

    appendFileSync(runningPath, `${say('assistant', 'the tidewatcher step finished')}\n`)
    const fresh = crypto.randomUUID()
    chat(A.dir, fresh, [say('user', 'begin the lanternfish audit')])
    await refreshCliTranscriptFiles() // the listing sees them; the index has not read them

    for (const [word, id] of [
      ['harbourline', running], // held by the index
      ['tidewatcher', running], // written after the index read the chat
      ['lanternfish', fresh], // a chat the index has not read at all
    ] as const) {
      const r = await searchSessionBodies({ query: word, instance: NAME_A })
      expect(r.searched).toBe('index')
      expect(r.budgetExhausted).toBe(false)
      expect(r.filesSearched).toBe(r.filesTotal)
      expect(r.results.map((h) => h.session_id)).toEqual([id])
    }
  },
  SWEEP_TIMEOUT_MS,
)

// A Free batch outlives the daemon that started it (2026-10-17). Each daemon here is a real process of its
// own, so a restart is a real exit: the first daemon sends, parks for its restart (or is killed mid-send),
// the second adopts what the first saved and answers for every task. A stand-in Desk 2 answers on a free
// port (HYDRA_DESK_PORT), never the real one, and holds its operations by request id the way Desk 2 does
// (desk2 service.ts start: a request id it already has answers with that operation). No provider traffic.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MCP_FREE = pathToFileURL(resolve(import.meta.dir, '../src/mcp-free.ts')).href
const accounts = [
  { id: 'synthetic-first', num: 1, provider: 'claude', name: 'First', loggedIn: true, usage: null },
  {
    id: 'synthetic-second',
    num: 2,
    provider: 'chatgpt',
    name: 'Second',
    loggedIn: true,
    usage: { available: true, unlimited_text: true, windows: [] },
  },
]
type Job = { id: string; instanceId: string; state: 'running' | 'done'; result: unknown }
const jobs = new Map<string, Job>()
const posts: { requestId: string; prompt: string }[] = []
let holdPost: Promise<void> | null = null
let server: ReturnType<typeof Bun.serve>
const dirs: string[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname.replace('/api/free', '')
      if (path === '/status')
        return Response.json({ ready: true, instances: accounts, jobs: [...jobs.values()] })
      if (path === '/threads') return Response.json([])
      if (path === '/jobs' && request.method === 'POST') {
        const body = (await request.json()) as {
          requestId: string
          instanceId: string
          prompt: string
        }
        posts.push({ requestId: body.requestId, prompt: body.prompt })
        const job = jobs.get(body.requestId) ?? {
          id: body.requestId,
          instanceId: body.instanceId,
          state: 'running' as const,
          result: { ok: true, chat_id: crypto.randomUUID(), response: `Answer to ${body.prompt}` },
        }
        jobs.set(job.id, job)
        if (holdPost) await holdPost
        return Response.json(job, { status: 202 })
      }
      if (path === '/jobs')
        return Response.json({
          jobs: Object.fromEntries(
            (url.searchParams.get('ids') ?? '').split(',').map((id) => [id, jobs.get(id) ?? null]),
          ),
        })
      const job = jobs.get(path.replace('/jobs/', ''))
      return job
        ? Response.json(job)
        : Response.json({ error: 'Unknown operation' }, { status: 404 })
    },
  })
})

afterEach(() => {
  jobs.clear()
  posts.length = 0
  holdPost = null
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A child's file still closing on Windows; the preload's temp sweep takes it.
    }
  }
})

afterAll(() => {
  server.stop(true)
})

/** One daemon's Free side: the real module in a process of its own, on the test's data folder. */
function daemon(dataDir: string, body: string) {
  return Bun.spawn(
    [
      process.execPath,
      '-e',
      `const free = await import(${JSON.stringify(MCP_FREE)})
       const run = (name, args) => free.FREE_TOOLS.find((t) => t.name === name).run(args)
       const say = (v) => console.log('@@' + JSON.stringify(v))
       ${body}`,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      env: {
        ...process.env,
        AGENTHYDRA_HOME: dataDir,
        AGENTHYDRA_DATA_DIR: join(dataDir, 'data'),
        HYDRA_DESK_PORT: String(server.port),
      },
    },
  )
}

async function said(child: ReturnType<typeof daemon>): Promise<any[]> {
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`daemon process failed (${code}): ${err}\n${out}`)
  return out
    .split('\n')
    .filter((l) => l.startsWith('@@'))
    .map((l) => JSON.parse(l.slice(2)))
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'free-batch-restart-'))
  dirs.push(dir)
  return dir
}

test('a restart while a batch runs hands every answer to the next daemon, each task sent once', async () => {
  const dir = scratch()
  // The first daemon: two tasks start, then a restart parks it, and a third task arrives during the handoff.
  const first = await said(
    daemon(
      dir,
      `const a = await run('free_chat', { tasks: [{ prompt: 'Synthetic one' }, { prompt: 'Synthetic two' }], wait_s: 0 })
       let s = a
       while (s.tasks.some((t) => t.state !== 'running')) s = await run('free_results', { batch: a.batch, wait_s: 0.2 })
       const parking = Date.now()
       await free.parkFreeBatches()
       const parkedMs = Date.now() - parking
       const started = Date.now()
       const b = await run('free_chat', { tasks: [{ prompt: 'Synthetic three' }], wait_s: 45 })
       say({ a: a.batch, b: b.batch, parkedMs, admitMs: Date.now() - started, states: b.tasks.map((t) => t.state) })
       await free.saveFreeBatches()
       process.exit(0)`,
    ),
  )
  const { a, b, parkedMs, admitMs, states } = first[0]
  // The restart waited for no task to finish, and the task admitted during it was neither refused nor sent.
  expect(parkedMs).toBeLessThan(5000)
  expect(admitMs).toBeLessThan(5000)
  expect(states).toEqual(['queued'])
  expect(posts.map((p) => p.prompt).sort()).toEqual(['Synthetic one', 'Synthetic two'])
  // The provider finishes the two running sends while no daemon is up.
  for (const job of jobs.values()) job.state = 'done'

  const next = daemon(
    dir,
    `await free.adoptFreeBatches()
     say(await run('free_results', { batch: ${JSON.stringify(a)}, wait_s: 15 }))
     say(await run('free_results', { batch: ${JSON.stringify(b)}, wait_s: 15 }))`,
  )
  // The task admitted during the handoff goes out from the next daemon, once.
  await until(() => posts.length === 3, 'the parked task to be sent')
  for (const job of jobs.values()) job.state = 'done'
  const [carried, admitted] = await said(next)
  expect(carried.tasks.map((t: any) => [t.state, t.response])).toEqual([
    ['done', 'Answer to Synthetic one'],
    ['done', 'Answer to Synthetic two'],
  ])
  expect(admitted.tasks.map((t: any) => [t.state, t.response])).toEqual([
    ['done', 'Answer to Synthetic three'],
  ])
  expect(posts.map((p) => p.prompt).sort()).toEqual([
    'Synthetic one',
    'Synthetic three',
    'Synthetic two',
  ])
}, 60_000)

test('a send cut off by a crash is resent under its own request id, so the provider gets it once', async () => {
  const dir = scratch()
  let letGo!: () => void
  holdPost = new Promise((r) => {
    letGo = r
  })
  const crashed = daemon(
    dir,
    `say(await run('free_chat', { tasks: [{ prompt: 'Synthetic cut off' }], wait_s: 0 }))
     await new Promise(() => {})`,
  )
  // Desk 2 has the operation, and the daemon dies before Desk 2's answer reaches it.
  await until(() => posts.length === 1, 'the first send')
  crashed.kill(9)
  await crashed.exited
  const line = (await new Response(crashed.stdout).text())
    .split('\n')
    .find((l) => l.startsWith('@@'))
  const { batch } = JSON.parse(line!.slice(2))
  holdPost = null
  letGo()
  for (const job of jobs.values()) job.state = 'done'

  const next = await said(
    daemon(
      dir,
      `await free.adoptFreeBatches()
       say(await run('free_results', { batch: ${JSON.stringify(batch)}, wait_s: 15 }))`,
    ),
  )
  expect(next[0].tasks.map((t: any) => [t.state, t.response])).toEqual([
    ['done', 'Answer to Synthetic cut off'],
  ])
  // Sent twice to Desk 2, both under one request id: one operation, one message to the provider.
  expect(posts).toHaveLength(2)
  expect(new Set(posts.map((p) => p.requestId)).size).toBe(1)
  expect(jobs.size).toBe(1)
}, 60_000)

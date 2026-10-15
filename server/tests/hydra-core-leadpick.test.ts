// server/tests/hydra-core-leadpick.test.ts - who a chat is told to be (one model call, the word ranker behind it),
// the lead following the work, the per-message additions' bar, the tree's become log and the seats line.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatPromptText, leadPickPending } from '../src/climayte-launch'
import type { CliMayteWorker } from '../src/climayte-lib'
import { loadCatalog } from '../src/hydra-core/catalog'
import {
  type Decider,
  hswarmDecide,
  LAUNCH_BUDGET_MS,
  type LeadQuestion,
  MESSAGE_BUDGET_MS,
  pickLead,
  setDecider,
} from '../src/hydra-core/lead'
import {
  matchFor,
  type PackRequest,
  type PlacedRequest,
  packAnswer,
  packFor,
  pickForMatch,
  pickForPack,
} from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { pickForPlace, placeChat } from '../src/hydra-core/placement'
import { answer, scope } from '../src/hydra-core/tree'
import { contentWords } from '../src/mcp-find'
import { scratch, startChat } from './hydra-core-fixture'

const T = Date.parse('2026-10-14T09:00:00Z')

/** The call sites' shape: the model's pick awaited first, then the synchronous build. */
const packed = async (d: string, req: PackRequest, now = new Date(T)) =>
  packFor(d, { ...req, pick: await pickForPack(d, req, now) }, now)
const matched = async (d: string, req: PlacedRequest, now = new Date(T)) =>
  matchFor(d, { ...req, pick: await pickForMatch(d, req, now) }, now)
const placed = async (d: string, req: Parameters<typeof placeChat>[1], now = new Date(T)) =>
  placeChat(d, { ...req, pick: await pickForPlace(d, req, now) }, now)
const CWD = 'C:/Users/me/app'
let dir = ''
let asked: { q: LeadQuestion; ms: number }[] = []

/** A mock model: answers from `pick(message)` after `delayMs`, or fails when it returns null. */
function mockModel(pick: (message: string) => string | null, delayMs = 0): void {
  const d: Decider = async (q, ms) => {
    asked.push({ q, ms })
    if (delayMs) await Bun.sleep(delayMs)
    const a = pick(q.message)
    return a === null ? { answer: null, error: 'mock: no answer' } : { answer: a }
  }
  setDecider(d)
}

const brief = (dir: string, slug: string, text: string) => {
  const file = join(dir, `${slug}.md`)
  writeFileSync(file, text)
  return { type: 'file', path: file }
}

const manager = (
  dir: string,
  slug: string,
  name: string,
  title: string,
  when: string,
  tags: string[],
) => ({
  id: `person:${slug}`,
  kind: 'person',
  name,
  title,
  tier: 'manager',
  family: 'manager',
  when,
  tags,
  modes: ['become', 'consult', 'hire'],
  cost: 'medium',
  how: `core_use { chat, id: "person:${slug}", mode: "become" | "consult" (with question) | "hire" (with job) }. Becoming loads its brief into this chat.`,
  load: brief(dir, slug, `${name} brief: invented text for ${title}.\n`),
})

function fiveManagers(dir: string): void {
  const entries = [
    manager(
      dir,
      'gil-floor',
      'Gil',
      'Floor Manager',
      'Takes every quick one-step ask in any field',
      ['quick', 'status'],
    ),
    manager(
      dir,
      'ivy-ui',
      'Ivy',
      'Head of UI Design',
      'Owns how every screen, layout and flow looks and works',
      ['screen', 'layout', 'design', 'sidebar'],
    ),
    manager(
      dir,
      'jay-ads',
      'Jay',
      'Head of Advertising',
      'Owns every ad, campaign, launch post and cold email',
      ['ads', 'campaign', 'launch'],
    ),
    manager(
      dir,
      'pia-project',
      'Pia',
      'Project Coordinator',
      'Splits a big multi-part ask into manager-sized pieces',
      ['project', 'split'],
    ),
    manager(
      dir,
      'sam-backend',
      'Sam',
      'Structural Backend Engineer',
      'Owns the backend: schema, servers, deploys, databases',
      ['backend', 'schema', 'database', 'server', 'migration'],
    ),
    {
      id: 'person:retention-expert',
      kind: 'person',
      name: 'Rhea Example',
      title: 'Retention expert',
      tier: 'employee',
      family: 'expert',
      when: 'Why players quit and how to bring them back',
      tags: ['retention', 'players', 'quit'],
      modes: ['become', 'consult'],
      cost: 'medium',
      how: 'core_use { chat, id, mode: "consult" }. Becoming loads its brief into this chat.',
      load: brief(dir, 'retention', 'Rhea brief: invented retention text.\n'),
    },
  ]
  writeFileSync(join(dir, 'catalog', 'hand-b2-managers.json'), JSON.stringify(entries))
}

beforeEach(() => {
  dir = scratch()
  fiveManagers(dir)
  asked = []
})
afterEach(() => {
  setDecider(null)
  delete process.env.AGENTHYDRA_DECIDE_URL
  delete process.env.AGENTHYDRA_HSWARM_TOKEN_FILE
  rmSync(dir, { recursive: true, force: true })
})

const logOf = (d: string) =>
  existsSync(join(d, 'log.jsonl'))
    ? readFileSync(join(d, 'log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : []
const entriesOf = (d: string) => [...loadCatalog(d).entries.values()]

describe('lead choice (A2-F1)', () => {
  test("the model picks among the managers' one-liners, none and the coordinator rule", async () => {
    mockModel(() => 'sam-backend')
    const pick = await pickLead(entriesOf(dir), 'add a last_seen column to the users table', 5000, {
      cache: false,
    })
    expect(pick).toMatchObject({ id: 'person:sam-backend', path: 'model' })
    const { q } = asked[0] as { q: LeadQuestion }
    expect(Object.keys(q.options)).toEqual(
      expect.arrayContaining([
        'gil-floor',
        'ivy-ui',
        'jay-ads',
        'none',
        'pia-project',
        'sam-backend',
      ]),
    )
    expect(Object.keys(q.options)).not.toContain('retention-expert')
    expect(q.options['ivy-ui']).toContain('Owns how every screen, layout and flow looks and works')
    expect(q.options.none).toMatch(/No work in the message/)
    expect(q.question).toContain("A message spanning several fields is Pia's.")
  })

  test('an answer of none gives no lead; a message with no content word is never asked', async () => {
    mockModel(() => 'none')
    expect(
      await pickLead(entriesOf(dir), 'rename notes.txt to todo.txt', 5000, { cache: false }),
    ).toMatchObject({
      id: null,
      path: 'model',
    })
    asked = []
    expect((await pickLead(entriesOf(dir), 'ok keep going', 5000, { cache: false })).id).toBeNull()
    expect(asked).toHaveLength(0)
  })

  test('a first launch waits up to 5 s for the model and a hook pack up to 1 s, and the path is logged', async () => {
    mockModel(() => 'ivy-ui')
    const launch = await packed(
      dir,
      {
        chat: 'lp-1',
        session: 's1',
        cwd: CWD,
        prompt: 'the sidebar is cramped on mobile',
        dry: true,
      },
      new Date(T),
    )
    expect(launch.lead).toBe('person:ivy-ui')
    expect(asked.at(-1)?.ms).toBe(LAUNCH_BUDGET_MS)
    expect(LAUNCH_BUDGET_MS).toBeLessThanOrEqual(5000)
    await packed(
      dir,
      { chat: 'lp-2', session: 's1', cwd: CWD, prompt: 'the inbox screen layout is cramped' },
      new Date(T),
    )
    expect(asked.at(-1)?.ms).toBe(MESSAGE_BUDGET_MS)
    expect(MESSAGE_BUDGET_MS).toBeLessThan(1500)
    const picks = logOf(dir).filter((e) => e.event === 'lead-pick')
    expect(picks.map((e) => [e.chat, e.id, e.path])).toEqual([
      ['lp-1', 'person:ivy-ui', 'model'],
      ['lp-2', 'person:ivy-ui', 'model'],
    ])
  })

  test('when the call fails the word ranker picks, and the log names the path and the error', async () => {
    mockModel(() => null)
    const pack = await packed(
      dir,
      {
        chat: 'lp-3',
        session: 's1',
        cwd: CWD,
        prompt: 'write the migration for the backend schema',
        dry: true,
      },
      new Date(T),
    )
    expect(pack.lead).toBe('person:sam-backend')
    expect(logOf(dir).find((e) => e.event === 'lead-pick')).toMatchObject({
      path: 'words',
      id: 'person:sam-backend',
      error: 'mock: no answer',
    })
  })

  test('the real call is awaited: a timer fires on time while the door is silent, and it gives up at its budget', async () => {
    const tok = join(dir, 'token')
    writeFileSync(tok, 'invented-token')
    process.env.AGENTHYDRA_HSWARM_TOKEN_FILE = tok
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    process.env.AGENTHYDRA_DECIDE_URL = `http://127.0.0.1:${server.port}/api/decide`
    const started = performance.now()
    const tick = new Promise<number>((r) => setTimeout(() => r(performance.now() - started), 50))
    const [got, tickMs] = await Promise.all([
      hswarmDecide({ message: 'm', question: 'q', options: { a: 'a', b: 'b' } }, 600),
      tick,
    ])
    const ms = performance.now() - started
    server.stop(true)
    expect(got.answer).toBeNull()
    expect(tickMs).toBeLessThan(250)
    expect(ms).toBeGreaterThanOrEqual(450)
    expect(ms).toBeLessThan(1100)
  })

  test('clearing a mock under test puts back no model call, so later test files never reach the network', async () => {
    mockModel(() => 'person:sam-backend')
    setDecider(null)
    await pickLead(entriesOf(dir), 'write the migration for the backend schema', 5000, {
      cache: false,
      log: { dir, chat: 'lp-net' },
    })
    expect(logOf(dir).find((e) => e.event === 'lead-pick')).toMatchObject({
      path: 'words',
      error: 'no model call under test',
    })
  })
})

describe('the word ranker behind the model (A2-F2, A2-F3)', () => {
  beforeEach(() => mockModel(() => null))

  test('filler words and the shared how line pick nobody', async () => {
    expect(
      contentWords('what should the chat do with its job, which loads into every view'),
    ).toEqual(['chat', 'job', 'loads', 'view'])
    const pick = await pickLead(entriesOf(dir), 'what loads its job into this chat', 5000, {
      cache: false,
    })
    expect(pick).toMatchObject({ id: null, path: 'words' })
  })

  test('a strong expert hit beats a weak manager hit instead of hiding behind it', async () => {
    const pick = await pickLead(
      entriesOf(dir),
      'why do players quit after the first level of the launch',
      5000,
      {
        cache: false,
      },
    )
    expect(pick.id).toBe('person:retention-expert')
  })

  test('three or more fields hit means the coordinator', async () => {
    const pick = await pickLead(
      entriesOf(dir),
      'the backend schema, the sidebar screen and the launch campaign',
      5000,
      { cache: false },
    )
    expect(pick.id).toBe('person:pia-project')
  })
})

describe('the lead follows the work (A2-F4, A3 finding 4)', () => {
  const launch = async (chat: string, prompt: string) =>
    await placed(
      dir,
      { chat, session: 's1', fresh: true, cwd: CWD, prompt, placement: 'slot' },
      new Date(T),
    )
  const msg = async (chat: string, prompt: string, at = 1) =>
    await matched(
      dir,
      { chat, session: 's1', cwd: CWD, prompt, placement: 'slot' },
      new Date(T + at),
    )

  test('a backend message in a UI chat gets a lead-change note with the new brief and becomes the next launch lead', async () => {
    mockModel((m) => (/sqlite|server/.test(m) ? 'sam-backend' : 'ivy-ui'))
    expect((await launch('shift', 'make the signup screen layout breathe')).text).toContain(
      'Ivy brief',
    )
    const got = await msg('shift', 'now add a small server that stores the signups in sqlite')
    expect(got.text).toContain(
      "Lead change: this message is Sam's field (Structural Backend Engineer), not Ivy's.",
    )
    expect(got.text).toContain('Sam brief: invented text for Structural Backend Engineer.')
    expect(got.ids).toContain('person:sam-backend')
    expect(readFileSync(chatPaths(dir, 'shift').hydraMd, 'utf8')).toContain(
      'Sam - Structural Backend Engineer',
    )
    expect(logOf(dir).find((e) => e.event === 'lead-shift')).toMatchObject({
      from: 'person:ivy-ui',
      to: 'person:sam-backend',
    })
    const next = await placed(
      dir,
      { chat: 'shift', session: 's2', fresh: true, cwd: CWD, prompt: 'x', placement: 'slot' },
      new Date(T + 5),
    )
    expect(next.text).toContain('Lead for this message: Sam\n\nSam brief: invented text')
  })

  test('keep going, a chore and same-field work never ask the model; a timeout keeps the lead', async () => {
    mockModel(() => 'ivy-ui')
    await launch('stay', 'make the signup screen layout breathe')
    asked = []
    expect((await msg('stay', 'keep going')).text).toBe('')
    expect((await msg('stay', 'ok', 2)).text).toBe('')
    await msg('stay', 'the settings screen layout needs more room', 3)
    expect(asked).toHaveLength(0)
    mockModel(() => null)
    const timedOut = await msg('stay', 'now store the signups in a new sqlite table', 4)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.ms).toBe(MESSAGE_BUDGET_MS)
    expect(timedOut.text).not.toContain('Lead change')
    expect(existsSync(chatPaths(dir, 'stay').hydraMd)).toBe(false)
  })

  test('a brief longer than 9,500 characters goes as its first two sections and the become line', async () => {
    const long = `# Sam\n\nIntro line.\n\n## One\n\nFirst part.\n\n## Two\n\nSecond part.\n\n## Three\n\n${'y'.repeat(12000)}\n`
    writeFileSync(join(dir, 'sam-backend.md'), long)
    mockModel((m) => (/sqlite/.test(m) ? 'sam-backend' : 'ivy-ui'))
    await launch('long', 'make the signup screen layout breathe')
    const got = await msg('long', 'now store the signups in a new sqlite table')
    expect(got.text).toContain('## Two\n\nSecond part.')
    expect(got.text).not.toContain('## Three')
    expect(got.text).toContain(
      'The whole brief: core_use { chat: "long", id: "person:sam-backend", mode: "become" }',
    )
    expect(got.chars).toBeLessThanOrEqual(9500)
  })
})

describe('per-message additions (A1-F4, A3 finding 6)', () => {
  beforeEach(() => mockModel(() => 'none'))

  function addEntries(): void {
    const k = (id: string, extra: Record<string, unknown>) => {
      const file = join(dir, `${id.replace(':', '-')}.md`)
      writeFileSync(file, `${id}: invented text.\n`)
      return {
        id,
        kind: 'knowledge',
        cost: 'free',
        how: 'read it',
        load: { type: 'file', path: file },
        tags: [],
        ...extra,
      }
    }
    const entries = [
      k('knowledge:filler-note', {
        name: 'Filler Note',
        when: 'What to do when you start work and find what you need',
      }),
      k('knowledge:widget-quota', {
        name: 'Widget Quota',
        when: 'Quota limits for the invented widget export',
      }),
      {
        ...k('instrument:here-tool', {
          name: 'Widget Exporter',
          when: 'Exports the invented widget quota report',
          folders: [CWD],
        }),
        kind: 'instrument',
      },
      {
        ...k('instrument:there-tool', {
          name: 'Widget Uploader',
          when: 'Uploads the invented widget quota report',
          folders: ['C:/Users/me/other'],
        }),
        kind: 'instrument',
      },
    ]
    writeFileSync(join(dir, 'catalog', 'hand-b2-adds.json'), JSON.stringify(entries))
  }
  const launch = async (chat: string, prompt = 'hello') =>
    await placed(
      dir,
      { chat, session: 's1', fresh: true, cwd: CWD, prompt, placement: 'slot' },
      new Date(T),
    )
  const msg = async (chat: string, prompt: string, session = 's1') =>
    await matched(dir, { chat, session, cwd: CWD, prompt, placement: 'slot' }, new Date(T + 1))

  test('filler words alone match nothing, and a short message gets nothing', async () => {
    addEntries()
    await launch('f1')
    expect(
      (await msg('f1', 'did the worker start? what did it find when you start work?')).ids,
    ).toEqual([])
    expect((await msg('f1', 'widget quota')).ids).toEqual([])
  })

  test('an entry of this folder is offered, one tied to another folder never is', async () => {
    addEntries()
    await launch('f2')
    const got = await msg('f2', 'export the widget quota report for the invented widget')
    expect(got.ids).toContain('instrument:here-tool')
    expect(got.ids).not.toContain('instrument:there-tool')
    expect(got.ids.length).toBeLessThanOrEqual(3)
    const line = logOf(dir).findLast((e) => e.phase === 'message') as {
      scores: Record<string, number>
    }
    expect(Object.keys(line.scores).sort()).toEqual([...got.ids].sort())
  })

  test("an entry already in the chat's slot is never attached again, even in a session the slot did not start", async () => {
    addEntries()
    await launch('f3', 'widget quota limits for the invented widget export')
    const placed = JSON.parse(readFileSync(chatPaths(dir, 'f3').placed, 'utf8')) as {
      ids: string[]
    }
    expect(placed.ids).toContain('knowledge:widget-quota')
    writeFileSync(chatPaths(dir, 'f3').sent, JSON.stringify({ other: [] }))
    expect(
      (await msg('f3', 'quota limits for the invented widget export', 'other')).ids,
    ).not.toContain('knowledge:widget-quota')
  })
})

test('a lead picked through the question tree logs a become as core_use does (A2-F6)', async () => {
  const chat = 'chat-example-tree'
  const now = new Date('2026-10-13T10:00:00.000Z')
  startChat(dir, chat, 'Rebuild the dashboard layout')
  scope(dir, chat, now)
  for (const a of [
    'yes: rebuild the dashboard layout',
    'delegate',
    '3',
    '2',
    'dashboard',
    '1',
    'none',
    'dashboard',
    '1',
  ])
    answer(dir, chat, { answer: a }, now)
  expect(answer(dir, chat, { answer: 'Lay out the grid.' }, now)).toMatchObject({
    verdict: 'hydra',
  })
  expect(logOf(dir).filter((e) => e.event === 'use')).toEqual([
    expect.objectContaining({
      chat,
      event: 'use',
      mode: 'become',
      id: 'person:iris-ui',
      via: 'tree',
    }),
  ])
})

test("the slot lists the chat's seats so a handoff knows whom it consulted", async () => {
  mockModel(() => 'none')
  const files = chatPaths(dir, 'seated')
  mkdirSync(files.root, { recursive: true })
  writeFileSync(
    files.seats,
    JSON.stringify({ 'person:ivy-ui': { chat: 'desk-chat-1', title: 'Ivy seat' } }),
  )
  const slot = await placed(
    dir,
    { chat: 'seated', session: 's1', fresh: true, cwd: CWD, prompt: 'hello', placement: 'slot' },
    new Date(T),
  )
  expect(slot.text).toContain(
    'Seats in this chat: Ivy (person:ivy-ui); resume one with core_use { chat: "seated", id: "<person id>", mode: "consult" }.',
  )
})

describe('the model call never blocks an event loop (B2 review 1)', () => {
  test("the daemon's pack answer awaits the pick: another request is served and a timer fires meanwhile", async () => {
    mockModel(() => 'ivy-ui', 400)
    const other = Bun.serve({ port: 0, fetch: () => new Response('pong') })
    const started = performance.now()
    const pack = packAnswer(
      dir,
      { chat: 'loop-1', session: 's1', cwd: CWD, prompt: 'the sidebar is cramped on mobile' },
      new Date(T),
    )
    let packed = 0
    void pack.then(() => {
      packed = performance.now() - started
    })
    const pong = await (await fetch(`http://127.0.0.1:${other.port}/`)).text()
    const pongMs = performance.now() - started
    const tickMs = await new Promise<number>((r) =>
      setTimeout(() => r(performance.now() - started), 30),
    )
    const got = await pack
    other.stop(true)
    expect(pong).toBe('pong')
    expect(pongMs).toBeLessThan(300)
    expect(tickMs).toBeLessThan(300)
    expect(packed).toBeGreaterThanOrEqual(390)
    expect('lead' in got && got.lead).toBe('person:ivy-ui')
  })

  test("a Prime chat's launch is held while its lead pick runs, then carries the pick", async () => {
    writeFileSync(join(dir, 'ON'), '')
    writeFileSync(join(dir, 'PLACEMENT'), 'slot\n')
    mockModel(() => 'ivy-ui', 200)
    const w = {
      id: 'w-hold',
      cwd: CWD,
      chat: true,
      prompt: 'make the signup screen layout breathe',
      attempts: [],
      desk: { chatId: 'desk-hold', append: '' },
    } as unknown as CliMayteWorker
    const started = performance.now()
    expect(leadPickPending(w)).toBe(true)
    const tickMs = await new Promise<number>((r) =>
      setTimeout(() => r(performance.now() - started), 20),
    )
    expect(tickMs).toBeLessThan(150)
    expect(leadPickPending(w)).toBe(true)
    await Bun.sleep(300)
    expect(leadPickPending(w)).toBe(false)
    expect(chatPromptText(w, { id: 'sess-hold', resume: false })).toContain('Ivy brief')
    expect(asked).toHaveLength(1)
    // Its lead is kept now: the next launch asks nothing and is not held.
    expect(leadPickPending({ ...w, id: 'w-hold-2' } as CliMayteWorker)).toBe(false)
  })
})

describe('quick asks and named continuations (B2 review 2 and 3)', () => {
  test("a quick ask is the floor manager's; none is only a message with no work in it", async () => {
    mockModel(() => 'gil-floor')
    const pick = await pickLead(entriesOf(dir), 'rename notes.txt to todo.txt', 5000, {
      cache: false,
    })
    expect(pick).toMatchObject({ id: 'person:gil-floor', path: 'model' })
    const { q } = asked[0] as { q: LeadQuestion }
    expect(q.question).toContain(
      "A quick ask (a fact, a status, a one-line edit, a single chore) is Gil's.",
    )
    expect(q.question).toContain('Answer none only when the message holds no work')
    expect(q.question).not.toContain('answer none for those')
    expect(q.options.none).not.toMatch(/chore|quick|fact|status/)
  })

  test("a continuation that names its work is asked and gets that work's lead; a bare one is never asked", async () => {
    mockModel((m) => (/campaign/.test(m) ? 'jay-ads' : 'none'))
    const named = await packed(
      dir,
      {
        chat: 'cont-1',
        session: 's1',
        cwd: CWD,
        prompt: 'keep going on the spring ad campaign, still need the second banner',
        dry: true,
      },
      new Date(T),
    )
    expect(named.lead).toBe('person:jay-ads')
    expect(asked[0]?.q.question).toContain(
      `A continuation that names its work ("keep going on <the work>, still need <X>") is that work's field's manager's.`,
    )
    expect(asked[0]?.q.question).toContain('the lead is the field where the fix lives')
    asked = []
    const bare = await packed(
      dir,
      { chat: 'cont-2', session: 's1', cwd: CWD, prompt: 'keep going', dry: true },
      new Date(T),
    )
    expect(bare.lead).toBeNull()
    expect(asked).toHaveLength(0)
  })

  test('on a later message a named continuation can move the lead; a bare one keeps it', async () => {
    mockModel((m) => (/campaign/.test(m) ? 'jay-ads' : 'ivy-ui'))
    await placed(
      dir,
      {
        chat: 'cont-3',
        session: 's1',
        fresh: true,
        cwd: CWD,
        prompt: 'make the signup screen layout breathe',
        placement: 'slot',
      },
      new Date(T),
    )
    asked = []
    const msg = (prompt: string, at: number) =>
      matched(
        dir,
        { chat: 'cont-3', session: 's1', cwd: CWD, prompt, placement: 'slot' },
        new Date(T + at),
      )
    expect((await msg('keep going', 1)).text).toBe('')
    expect(asked).toHaveLength(0)
    const moved = await msg('keep going on the ad campaign, still need the banner copy', 2)
    expect(moved.text).toContain("Lead change: this message is Jay's field")
  })
})

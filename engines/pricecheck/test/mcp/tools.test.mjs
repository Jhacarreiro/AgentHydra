// The price_check tools: each one runs the pricecheck CLI once with the calling folder's checkout as --root, and shapes
// the answer. The CLI, git and the dashboard API are stubbed, so these tests never start a browser or touch a repo.
import '../advice/lessons-home.mjs'
import { afterEach, beforeEach, expect, describe as group, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adviceFile, appendRow, readRows } from '../../lib/advice/log.mjs'
import { reconcile as reconcileAdvice } from '../../lib/advice/reconcile.mjs'
import { priceCheckTools } from '../../mcp/tools.mjs'

const PRICECHECK_TOOLS = priceCheckTools()
const ROOT = 'C:/Users/example/Projects/example-shop'
const FIRST_SENTENCE =
  'Prices every page of a web app: what each page costs the person looking at it (words, controls, fields, sections, other-product pushes...) and which file each point comes from.'

const scanJson = {
  root: ROOT,
  mode: 'scan',
  pages: [
    {
      page: 'src/views/Checkout.vue',
      route: '/checkout',
      points: 40,
      units: { word: 30, control: 10 },
      byFile: {
        'src/views/Checkout.vue': { points: 30, units: { word: 30 } },
        'src/Buy.vue': { points: 10, units: { control: 10 } },
      },
      exposure: 3,
    },
    {
      page: 'src/views/Landing.vue',
      route: '/',
      points: 20,
      units: { word: 20 },
      byFile: { 'src/views/Landing.vue': { points: 20, units: { word: 20 } } },
    },
  ],
}

const ok = (stdout) => ({ code: 0, stdout, stderr: '', overBudget: false })

const fakeDeps = (answer, over = {}) => {
  const calls = []
  const posts = []
  const reconciled = []
  const deps = {
    runCli: async (args, root, timeoutMs) => {
      calls.push({ args, root, timeoutMs })
      return answer(args)
    },
    gitRoot: async () => ROOT,
    postDashboard: async (body) => {
      posts.push(body)
      return { url: 'http://127.0.0.1:7777/dashboards/example/price/index.html' }
    },
    reconcile: (root) => {
      reconciled.push(root)
    },
    ...over,
  }
  return { deps, calls, posts, reconciled }
}

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'pricecheck.mjs')

const realCli = (args, root) =>
  new Promise((done) => {
    execFile(
      process.execPath,
      [BIN, ...args, '--root', root],
      { cwd: root, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        done({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          overBudget: false,
        })
      },
    )
  })

const OTHER = 'C:/Users/example/Projects/other-app'

const seedAdvice = (row) =>
  appendRow(adviceFile(), {
    type: 'advice',
    kind: 'next',
    version: 'test',
    head: null,
    ...row,
  })

const seedFeedback = (row) =>
  appendRow(adviceFile(), { type: 'feedback', at: '2026-10-05T00:00:00.000Z', ...row })

const byName = (tools, name) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

let home
const savedHome = process.env.PRICECHECK_HOME
const savedChat = process.env.HYDRA_DESK_CHAT_ID

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pricecheck-mcp-'))
  process.env.PRICECHECK_HOME = home
  delete process.env.HYDRA_DESK_CHAT_ID
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.PRICECHECK_HOME
  else process.env.PRICECHECK_HOME = savedHome
  if (savedChat === undefined) delete process.env.HYDRA_DESK_CHAT_ID
  else process.env.HYDRA_DESK_CHAT_ID = savedChat
})

group('the tool list', () => {
  test('exports the tools with unique names', () => {
    const names = PRICECHECK_TOOLS.map((t) => t.name)
    expect(names).toEqual([
      'price_check',
      'price_check_next',
      'price_check_live',
      'price_check_freeze',
      'price_check_report',
      'price_check_advice',
      'price_check_feedback',
    ])
  })
  test('lists only price_check', () => {
    const listed = PRICECHECK_TOOLS.filter((t) => t.listed).map((t) => t.name)
    expect(listed).toEqual(['price_check'])
  })
  test('price_check opens with the agreed first sentence', () => {
    const tool = PRICECHECK_TOOLS.find((t) => t.name === 'price_check')
    expect(tool.description.startsWith(FIRST_SENTENCE)).toBe(true)
  })
  test('the mutating tools say MUTATES:', () => {
    for (const name of ['price_check_freeze', 'price_check_report', 'price_check_feedback']) {
      expect(PRICECHECK_TOOLS.find((t) => t.name === name).description.startsWith('MUTATES:')).toBe(true)
    }
  })
  test('no read tool says MUTATES:', () => {
    for (const name of ['price_check', 'price_check_next', 'price_check_live', 'price_check_advice']) {
      expect(PRICECHECK_TOOLS.find((t) => t.name === name).description).not.toContain('MUTATES:')
    }
  })
  test('the new tools are unlisted and run from the Desk chat', () => {
    for (const name of ['price_check_advice', 'price_check_feedback']) {
      const tool = PRICECHECK_TOOLS.find((t) => t.name === name)
      expect(tool.listed).toBeFalsy()
      expect(tool.callerChat).toBe('deskChat')
    }
  })
  test('price_check_feedback names its verdicts and when to call it', () => {
    const tool = PRICECHECK_TOOLS.find((t) => t.name === 'price_check_feedback')
    expect(tool.description).toContain('wrong')
    expect(tool.description).toContain('undid')
    expect(tool.inputSchema.required).toEqual(['verdict', 'claim'])
  })
})

group('price_check', () => {
  test('mode scan runs one scan with --root and returns the pages cut to limit, with describe', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    const tools = priceCheckTools({}, deps)
    const out = await byName(tools, 'price_check').run({
      cwd: ROOT,
      mode: 'scan',
      limit: 1,
    })
    expect(calls.length).toBe(1)
    expect(calls[0].args).toEqual(['scan', '--json'])
    expect(calls[0].root).toBe(ROOT)
    expect(out.total).toBe(60)
    expect(out.pagesTotal).toBe(2)
    expect(out.pages.length).toBe(1)
    expect(out.pages[0].page).toBe('src/views/Checkout.vue')
    expect(typeof out.pages[0].describe).toBe('string')
    expect(out.history.recorded).toBe(true)
  })

  test('a scan that runs past the budget says so and does not throw', async () => {
    const { deps } = fakeDeps(() => ({ code: null, stdout: '', stderr: '', overBudget: true }))
    const out = await byName(priceCheckTools({}, deps), 'price_check').run({
      cwd: ROOT,
      mode: 'scan',
    })
    expect(out.ok).toBe(false)
    expect(out.overBudget).toBe(true)
  })

  test('mode page without page is refused before any CLI run', async () => {
    const { deps, calls } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools({}, deps), 'price_check').run({ cwd: ROOT, mode: 'page' }),
    ).rejects.toThrow(/page/)
    expect(calls.length).toBe(0)
  })

  test('mode page with tree asks the CLI for the render tree and returns its lines, not the nested nodes', async () => {
    const row = {
      ...scanJson.pages[1],
      tree: { children: [{ points: 20, children: [] }] },
      treeLines: ['     20  <Hero> src/Hero.vue'],
    }
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify(row)))
    const out = await byName(priceCheckTools({}, deps), 'price_check').run({
      cwd: ROOT,
      mode: 'page',
      page: 'src/views/Landing.vue',
      tree: true,
    })
    expect(calls[0].args).toEqual(['page', 'src/views/Landing.vue', '--json', '--tree'])
    expect(out.treeLines).toEqual(['     20  <Hero> src/Hero.vue'])
    expect(out.tree).toBeUndefined()
  })

  test('mode check reports ok false with the failure lines when the CLI exits non-zero', async () => {
    const { deps } = fakeDeps(() => ({
      code: 1,
      stdout: 'Checkout.vue rose 12 points\n',
      stderr: '',
      overBudget: false,
    }))
    const out = await byName(priceCheckTools({}, deps), 'price_check').run({
      cwd: ROOT,
      mode: 'check',
    })
    expect(out.ok).toBe(false)
    expect(out.failures).toEqual(['Checkout.vue rose 12 points'])
  })

  test('an unknown mode is refused', async () => {
    const { deps } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools({}, deps), 'price_check').run({ cwd: ROOT, mode: 'nope' }),
    ).rejects.toThrow(/mode/)
  })
})

group('price_check_next', () => {
  test('returns a pick with a brief that names the CLI and the page', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    const out = await byName(priceCheckTools({}, deps), 'price_check_next').run({ cwd: ROOT })
    expect(calls[0].args).toEqual(['scan', '--json'])
    expect(out.next.page).toBe('src/views/Checkout.vue')
    expect(out.next.brief).toContain('src/views/Checkout.vue')
    expect(out.next.brief).toContain('--root')
    expect(out.progress).toBeNull()
  })
})

group('price_check_live', () => {
  test('refuses a url that is not http or https before any CLI run', async () => {
    const { deps, calls } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools({}, deps), 'price_check_live').run({
        cwd: ROOT,
        url: 'file:///etc/passwd',
      }),
    ).rejects.toThrow(/http/)
    expect(calls.length).toBe(0)
  })

  test('runs live with the url and returns the CLI JSON', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify({ pages: [{ page: 'x' }] })))
    const out = await byName(priceCheckTools({}, deps), 'price_check_live').run({
      cwd: ROOT,
      url: 'https://example.test/',
    })
    expect(calls[0].args.slice(0, 2)).toEqual(['live', 'https://example.test/'])
    expect(out.pages[0].page).toBe('x')
  })
})

group('price_check_freeze', () => {
  test('passes the reason to freeze and names the baseline file', async () => {
    const { deps, calls } = fakeDeps(() => ok('frozen 2 pages'))
    const out = await byName(priceCheckTools({}, deps), 'price_check_freeze').run({
      cwd: ROOT,
      reason: 'new checkout',
    })
    expect(calls[0].args).toEqual(['freeze', '--reason', 'new checkout'])
    expect(out.ok).toBe(true)
    expect(out.baseline).toContain('baseline.json')
  })
})

group('price_check_report', () => {
  test('writes only price/index.html into the dashboard and returns its url', async () => {
    const { deps, posts } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    const out = await byName(priceCheckTools({}, deps), 'price_check_report').run({
      cwd: ROOT,
    })
    expect(posts.length).toBe(1)
    const body = posts[0]
    expect(body.cwd).toBe(ROOT)
    expect(body.files.map((f) => f.path)).toEqual(['price/index.html'])
    expect(body.files[0].content).toContain('<!doctype html>')
    expect(out.url).toContain('price/index.html')
    expect(out.file).toBe('price/index.html')
  })

  test('without a dashboard it writes the report under PRICECHECK_HOME/reports/<repo> and returns the path', async () => {
    const { deps } = fakeDeps(() => ok(JSON.stringify(scanJson)), { postDashboard: undefined })
    const out = await byName(priceCheckTools({}, deps), 'price_check_report').run({ cwd: ROOT })
    const file = join(home, 'reports', 'example-shop', 'index.html')
    expect(out.path).toBe(file)
    expect(out.url).toBeNull()
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('<!doctype html>')
  })
})

group('advice from price_check_next', () => {
  test('records the brief as advice and returns its id inside the brief', async () => {
    const { deps } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    const out = await byName(priceCheckTools({}, deps), 'price_check_next').run({ cwd: ROOT })
    expect(typeof out.adviceId).toBe('string')
    expect(out.next.adviceId).toBe(out.adviceId)
    expect(out.next.brief).toContain(out.adviceId)
    const rows = readRows(adviceFile()).filter((r) => r.type === 'advice')
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(out.adviceId)
    expect(rows[0].kind).toBe('next')
    expect(rows[0].root).toBe(ROOT)
    expect(rows[0].page).toBe('src/views/Checkout.vue')
    expect(rows[0].points).toBe(40)
    expect(rows[0].claim).toContain('src/views/Checkout.vue')
    expect(rows[0].files.map((f) => f.file)).toEqual(['src/views/Checkout.vue', 'src/Buy.vue'])
  })

  test('with no page to trim there is no advice and no id', async () => {
    const { deps } = fakeDeps(() => ok(JSON.stringify({ ...scanJson, pages: [] })))
    const out = await byName(priceCheckTools({}, deps), 'price_check_next').run({ cwd: ROOT })
    expect(out.next).toBeNull()
    expect(out.adviceId).toBeNull()
    expect(readRows(adviceFile()).length).toBe(0)
  })

  test('a reconcile failure does not fail the pick', async () => {
    const { deps } = fakeDeps(() => ok(JSON.stringify(scanJson)), {
      reconcile: () => {
        throw new Error('advice log unreadable')
      },
    })
    const out = await byName(priceCheckTools({}, deps), 'price_check_next').run({ cwd: ROOT })
    expect(out.next.page).toBe('src/views/Checkout.vue')
    expect(typeof out.adviceId).toBe('string')
  })
})

group('reconcile after each scan', () => {
  test('a scan reconciles its root once', async () => {
    const { deps, reconciled } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    await byName(priceCheckTools({}, deps), 'price_check').run({ cwd: ROOT, mode: 'scan' })
    expect(reconciled).toEqual([ROOT])
  })

  test('price_check_next reconciles too, since it scans', async () => {
    const { deps, reconciled } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    await byName(priceCheckTools({}, deps), 'price_check_next').run({ cwd: ROOT })
    expect(reconciled).toEqual([ROOT])
  })

  test('a reconcile failure does not fail a scan', async () => {
    const { deps } = fakeDeps(() => ok(JSON.stringify(scanJson)), {
      reconcile: () => {
        throw new Error('advice log unreadable')
      },
    })
    const out = await byName(priceCheckTools({}, deps), 'price_check').run({
      cwd: ROOT,
      mode: 'scan',
    })
    expect(out.pages.length).toBe(2)
    expect(out.history.recorded).toBe(true)
  })

  test('a later scan that cut the advised page marks the advice followed', async () => {
    let current = scanJson
    const { deps } = fakeDeps(() => ok(JSON.stringify(current)), { reconcile: reconcileAdvice })
    const tools = priceCheckTools({}, deps)
    const next = await byName(tools, 'price_check_next').run({ cwd: ROOT })
    await new Promise((done) => setTimeout(done, 5))
    current = { ...scanJson, pages: [{ ...scanJson.pages[0], points: 30 }, scanJson.pages[1]] }
    await byName(tools, 'price_check').run({ cwd: ROOT, mode: 'scan' })
    const outcomes = readRows(adviceFile()).filter((r) => r.type === 'outcome')
    expect(outcomes.map((o) => [o.adviceId, o.kind])).toEqual([[next.adviceId, 'followed']])
    const summary = await byName(tools, 'price_check_advice').run({ cwd: ROOT })
    expect(summary.summary.followed).toBe(1)
  })
})

group('price_check_advice', () => {
  const seedTwo = () => {
    seedAdvice({ id: 'a1', at: '2026-10-01T00:00:00.000Z', root: ROOT, page: 'src/views/Checkout.vue', points: 40, claim: 'trim checkout' })
    seedAdvice({ id: 'a2', at: '2026-10-02T00:00:00.000Z', root: ROOT, page: 'src/views/Landing.vue', points: 20, claim: 'trim landing' })
  }

  test('a project with no advice is a clear zero, not an error', async () => {
    const { deps } = fakeDeps(() => ok('{}'))
    const out = await byName(priceCheckTools({}, deps), 'price_check_advice').run({ cwd: ROOT })
    expect(out.summary).toEqual({
      issued: 0,
      followed: 0,
      undone: 0,
      misled: 0,
      wrong: 0,
      right: 0,
      stale: 0,
      open: 0,
      badRate: null,
    })
    expect(out.latestBad).toBeNull()
  })

  test('for one project it counts that project only', async () => {
    seedTwo()
    seedAdvice({ id: 'b1', at: '2026-10-03T00:00:00.000Z', root: OTHER, page: 'src/Home.vue', points: 9, claim: 'trim home' })
    const { deps } = fakeDeps(() => ok('{}'))
    const out = await byName(priceCheckTools({}, deps), 'price_check_advice').run({ cwd: ROOT })
    expect(out.summary.issued).toBe(2)
    expect(out.summary.open).toBe(2)
    expect(out.summary.badRate).toBe(0)
  })

  test('all projects counts every project', async () => {
    seedTwo()
    seedAdvice({ id: 'b1', at: '2026-10-03T00:00:00.000Z', root: OTHER, page: 'src/Home.vue', points: 9, claim: 'trim home' })
    const { deps } = fakeDeps(() => ok('{}'))
    const out = await byName(priceCheckTools({}, deps), 'price_check_advice').run({
      cwd: ROOT,
      all: true,
    })
    expect(out.root).toBeNull()
    expect(out.projects).toBe(2)
    expect(out.summary.issued).toBe(3)
    expect(out.summary.open).toBe(3)
  })

  test('a wrong verdict makes advice bad, and latestBad carries its why', async () => {
    seedTwo()
    seedFeedback({ id: 'f1', adviceId: 'a2', verdict: 'wrong', claim: 'the trim did not move', why: 'the page is one block', root: ROOT })
    const { deps } = fakeDeps(() => ok('{}'))
    const out = await byName(priceCheckTools({}, deps), 'price_check_advice').run({ cwd: ROOT })
    expect(out.summary.wrong).toBe(1)
    expect(out.summary.open).toBe(1)
    expect(out.summary.badRate).toBe(0.5)
    expect(out.latestBad.id).toBe('a2')
    expect(out.latestBad.why).toBe('the page is one block')
    expect(out.latestBad.verdicts).toEqual(['wrong'])
  })

  test('latestBad is the newest bad advice', async () => {
    seedTwo()
    seedFeedback({ id: 'f1', adviceId: 'a1', verdict: 'undone', claim: 'undid it', root: ROOT })
    seedFeedback({ id: 'f2', adviceId: 'a2', verdict: 'wrong', claim: 'not cheaper', root: ROOT })
    const { deps } = fakeDeps(() => ok('{}'))
    const out = await byName(priceCheckTools({}, deps), 'price_check_advice').run({ cwd: ROOT })
    expect(out.summary.badRate).toBe(1)
    expect(out.latestBad.id).toBe('a2')
    expect(out.latestBad.why).toBeNull()
  })

  test('is read-only: it runs no CLI', async () => {
    seedTwo()
    const { deps, calls } = fakeDeps(() => ok('{}'))
    await byName(priceCheckTools({}, deps), 'price_check_advice').run({ cwd: ROOT, all: true })
    expect(calls.length).toBe(0)
  })
})

group('price_check_feedback', () => {
  test('passes every given argument through to the CLI feedback command', async () => {
    const { deps, calls } = fakeDeps(() => ok('recorded feedback 1a2b3c4d (wrong) on advice a2'))
    const out = await byName(priceCheckTools({}, deps), 'price_check_feedback').run({
      cwd: ROOT,
      verdict: 'wrong',
      claim: 'Checkout is cheaper',
      advice: 'a2',
      page: 'src/views/Checkout.vue',
      why: 'the trim did not move it',
      by: 'owner',
    })
    expect(calls[0].args).toEqual([
      'feedback',
      '--verdict',
      'wrong',
      '--claim',
      'Checkout is cheaper',
      '--advice',
      'a2',
      '--page',
      'src/views/Checkout.vue',
      '--why',
      'the trim did not move it',
      '--by',
      'owner',
    ])
    expect(calls[0].root).toBe(ROOT)
    expect(out.id).toBe('1a2b3c4d')
    expect(out.verdict).toBe('wrong')
  })

  test('leaves out the optional flags that are not given', async () => {
    const { deps, calls } = fakeDeps(() => ok('recorded feedback 00ff00ff (right)'))
    await byName(priceCheckTools({}, deps), 'price_check_feedback').run({
      cwd: ROOT,
      verdict: 'right',
      claim: 'the trim held',
    })
    expect(calls[0].args).toEqual(['feedback', '--verdict', 'right', '--claim', 'the trim held'])
  })

  test('a CLI refusal comes back as an error with its message', async () => {
    const { deps } = fakeDeps(() => ({
      code: 2,
      stdout: '',
      stderr: 'no advice zz for this root\n',
      overBudget: false,
    }))
    await expect(
      byName(priceCheckTools({}, deps), 'price_check_feedback').run({
        cwd: ROOT,
        verdict: 'wrong',
        claim: 'x',
        advice: 'zz',
      }),
    ).rejects.toThrow(/no advice zz/)
  })

  test('a missing verdict is refused before any CLI run', async () => {
    const { deps, calls } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools({}, deps), 'price_check_feedback').run({ cwd: ROOT, claim: 'x' }),
    ).rejects.toThrow(/verdict/)
    expect(calls.length).toBe(0)
  })

  test('a missing claim is refused before any CLI run', async () => {
    const { deps, calls } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools({}, deps), 'price_check_feedback').run({ cwd: ROOT, verdict: 'wrong', claim: '  ' }),
    ).rejects.toThrow(/claim/)
    expect(calls.length).toBe(0)
  })

  test('a feedback over the call budget is an error, since a retry could record it twice', async () => {
    const { deps } = fakeDeps(() => ({ code: null, stdout: '', stderr: '', overBudget: true }))
    await expect(
      byName(priceCheckTools({}, deps), 'price_check_feedback').run({ cwd: ROOT, verdict: 'right', claim: 'x' }),
    ).rejects.toThrow(/price_check_advice/)
  })

  test('the real CLI records it, and price_check_advice shows it as wrong', async () => {
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    seedAdvice({ id: 'real1', at: '2026-10-01T00:00:00.000Z', root: project, page: 'src/views/Checkout.vue', points: 40, claim: 'trim checkout' })
    const { deps } = fakeDeps(() => ok('{}'), { runCli: realCli, gitRoot: async () => project })
    const tools = priceCheckTools({}, deps)
    const made = await byName(tools, 'price_check_feedback').run({
      cwd: project,
      verdict: 'wrong',
      claim: 'Checkout is cheaper',
      advice: 'real1',
      why: 'the page is one block',
    })
    expect(made.id).toMatch(/^[0-9a-f]{8}$/)
    const summary = await byName(tools, 'price_check_advice').run({ cwd: project })
    expect(summary.summary.wrong).toBe(1)
    expect(summary.latestBad.id).toBe('real1')
    expect(summary.latestBad.why).toBe('the page is one block')
  })

  test('the real CLI refuses a verdict it does not know, and the refusal reaches the caller', async () => {
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    const { deps } = fakeDeps(() => ok('{}'), { runCli: realCli, gitRoot: async () => project })
    await expect(
      byName(priceCheckTools({}, deps), 'price_check_feedback').run({
        cwd: project,
        verdict: 'maybe',
        claim: 'x',
      }),
    ).rejects.toThrow(/wrong, undone or right/)
  })
})

group('host options', () => {
  test('the CLI gets the default 42 s: the 50 s call budget less 8 s to answer', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    await byName(priceCheckTools({}, deps), 'price_check').run({ cwd: ROOT, mode: 'scan' })
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(42_000)
    expect(calls[0].timeoutMs).toBeGreaterThan(41_000)
  })

  test('callBudgetMs from the host sets the CLI budget', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    await byName(priceCheckTools({ callBudgetMs: 20_000 }, deps), 'price_check').run({ cwd: ROOT, mode: 'scan' })
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(12_000)
    expect(calls[0].timeoutMs).toBeGreaterThan(11_000)
  })

  test('folderOf from the host picks the folder the checkout is found from', async () => {
    const folders = []
    const { deps } = fakeDeps(() => ok('{}'), {
      gitRoot: async (folder) => {
        folders.push(folder)
        return ROOT
      },
    })
    await byName(priceCheckTools({ folderOf: async () => ({ cwd: OTHER }) }, deps), 'price_check_advice').run({})
    expect(folders).toEqual([OTHER])
  })

  test('without a folder argument or a host folderOf, the folder is the process working folder', async () => {
    const folders = []
    const { deps } = fakeDeps(() => ok('{}'), {
      gitRoot: async (folder) => {
        folders.push(folder)
        return ROOT
      },
    })
    await byName(priceCheckTools({}, deps), 'price_check_advice').run({})
    expect(folders).toEqual([process.cwd()])
  })
})

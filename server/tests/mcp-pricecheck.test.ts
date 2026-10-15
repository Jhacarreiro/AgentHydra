// The price_check tools: each one runs the pricecheck CLI once with the calling folder's checkout as --root, and shapes
// the answer. The CLI, git and the dashboard API are stubbed, so these tests never start a browser or touch a repo.
import { afterEach, beforeEach, expect, describe as group, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CliRun,
  PRICECHECK_TOOLS,
  type PriceCheckDeps,
  priceCheckTools,
} from '../src/mcp-pricecheck'

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

const ok = (stdout: string): CliRun => ({ code: 0, stdout, stderr: '', overBudget: false })

const fakeDeps = (answer: (args: string[]) => CliRun) => {
  const calls: { args: string[]; root: string }[] = []
  const posts: unknown[] = []
  const deps: PriceCheckDeps = {
    runCli: async (args, root) => {
      calls.push({ args, root })
      return answer(args)
    },
    gitRoot: async () => ROOT,
    postDashboard: async (body) => {
      posts.push(body)
      return { url: 'http://127.0.0.1:7777/dashboards/example/price/index.html' }
    },
  }
  return { deps, calls, posts }
}

const byName = (tools: ReturnType<typeof priceCheckTools>, name: string) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

let home: string
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
  test('exports the four-plus-one tools with unique names', () => {
    const names = PRICECHECK_TOOLS.map((t) => t.name)
    expect(names).toEqual([
      'price_check',
      'price_check_next',
      'price_check_live',
      'price_check_freeze',
      'price_check_report',
    ])
  })
  test('lists only price_check', () => {
    const listed = PRICECHECK_TOOLS.filter((t) => t.listed).map((t) => t.name)
    expect(listed).toEqual(['price_check'])
  })
  test('price_check opens with the agreed first sentence', () => {
    const tool = PRICECHECK_TOOLS.find((t) => t.name === 'price_check')!
    expect(tool.description.startsWith(FIRST_SENTENCE)).toBe(true)
  })
  test('the mutating tools say MUTATES:', () => {
    for (const name of ['price_check_freeze', 'price_check_report']) {
      expect(
        PRICECHECK_TOOLS.find((t) => t.name === name)!.description.startsWith('MUTATES:'),
      ).toBe(true)
    }
  })
  test('no read tool says MUTATES:', () => {
    for (const name of ['price_check', 'price_check_next', 'price_check_live']) {
      expect(PRICECHECK_TOOLS.find((t) => t.name === name)!.description).not.toContain('MUTATES:')
    }
  })
})

group('price_check', () => {
  test('mode scan runs one scan with --root and returns the pages cut to limit, with describe', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    const tools = priceCheckTools(deps)
    const out = (await byName(tools, 'price_check').run({
      cwd: ROOT,
      mode: 'scan',
      limit: 1,
    })) as any
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
    const out = (await byName(priceCheckTools(deps), 'price_check').run({
      cwd: ROOT,
      mode: 'scan',
    })) as any
    expect(out.ok).toBe(false)
    expect(out.overBudget).toBe(true)
  })

  test('mode page without page is refused before any CLI run', async () => {
    const { deps, calls } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools(deps), 'price_check').run({ cwd: ROOT, mode: 'page' }),
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
    const out = (await byName(priceCheckTools(deps), 'price_check').run({
      cwd: ROOT,
      mode: 'page',
      page: 'src/views/Landing.vue',
      tree: true,
    })) as any
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
    const out = (await byName(priceCheckTools(deps), 'price_check').run({
      cwd: ROOT,
      mode: 'check',
    })) as any
    expect(out.ok).toBe(false)
    expect(out.failures).toEqual(['Checkout.vue rose 12 points'])
  })

  test('an unknown mode is refused', async () => {
    const { deps } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools(deps), 'price_check').run({ cwd: ROOT, mode: 'nope' }),
    ).rejects.toThrow(/mode/)
  })
})

group('price_check_next', () => {
  test('returns a pick with a brief that names the CLI and the page', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    const out = (await byName(priceCheckTools(deps), 'price_check_next').run({ cwd: ROOT })) as any
    expect(calls[0].args).toEqual(['scan', '--json'])
    expect(out.next.page).toBe('src/views/Checkout.vue')
    expect(out.next.brief).toContain('src/views/Checkout.vue')
    expect(out.next.brief).toContain('--root')
    expect(out.progress.first.total).toBe(60)
    expect(out.progress.dropped).toBe(0)
  })
})

group('price_check_live', () => {
  test('refuses a url that is not http or https before any CLI run', async () => {
    const { deps, calls } = fakeDeps(() => ok('{}'))
    await expect(
      byName(priceCheckTools(deps), 'price_check_live').run({
        cwd: ROOT,
        url: 'file:///etc/passwd',
      }),
    ).rejects.toThrow(/http/)
    expect(calls.length).toBe(0)
  })

  test('runs live with the url and returns the CLI JSON', async () => {
    const { deps, calls } = fakeDeps(() => ok(JSON.stringify({ pages: [{ page: 'x' }] })))
    const out = (await byName(priceCheckTools(deps), 'price_check_live').run({
      cwd: ROOT,
      url: 'https://example.test/',
    })) as any
    expect(calls[0].args.slice(0, 2)).toEqual(['live', 'https://example.test/'])
    expect(out.pages[0].page).toBe('x')
  })
})

group('price_check_freeze', () => {
  test('passes the reason to freeze and names the baseline file', async () => {
    const { deps, calls } = fakeDeps(() => ok('frozen 2 pages'))
    const out = (await byName(priceCheckTools(deps), 'price_check_freeze').run({
      cwd: ROOT,
      reason: 'new checkout',
    })) as any
    expect(calls[0].args).toEqual(['freeze', '--reason', 'new checkout'])
    expect(out.ok).toBe(true)
    expect(out.baseline).toContain('baseline.json')
  })
})

group('price_check_report', () => {
  test('writes only price/index.html into the dashboard and returns its url', async () => {
    const { deps, posts } = fakeDeps(() => ok(JSON.stringify(scanJson)))
    const out = (await byName(priceCheckTools(deps), 'price_check_report').run({
      cwd: ROOT,
    })) as any
    expect(posts.length).toBe(1)
    const body = posts[0] as any
    expect(body.cwd).toBe(ROOT)
    expect(body.files.map((f: any) => f.path)).toEqual(['price/index.html'])
    expect(body.files[0].content).toContain('<!doctype html>')
    expect(out.url).toContain('price/index.html')
    expect(out.file).toBe('price/index.html')
  })
})

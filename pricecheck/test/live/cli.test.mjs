import { describe as group, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { priceList } from '../../lib/model.mjs'
import { formatHuman, parseArgs, priceReport, readPriceList } from '../../lib/live/cli.mjs'

group('live cli: arguments', () => {
  test('a URL alone prices with the default output', () => {
    expect(parseArgs(['https://example.test/pricing'])).toEqual({
      url: 'https://example.test/pricing',
      cdp: null,
      json: false,
      root: process.cwd(),
    })
  })

  test('--json and --cdp are read in any position', () => {
    expect(parseArgs(['--cdp', 'http://127.0.0.1:9222', 'https://example.test/', '--json'])).toEqual({
      url: 'https://example.test/',
      cdp: 'http://127.0.0.1:9222',
      json: true,
      root: process.cwd(),
    })
  })

  test('--root names the project the components and price list come from (the MCP tool passes it)', () => {
    expect(parseArgs(['https://example.test', '--root', '/app']).root).toBe('/app')
    expect(parseArgs(['https://example.test']).root).toBe(process.cwd())
    expect(() => parseArgs(['https://example.test', '--root'])).toThrow('--root needs a folder')
  })

  test('a missing URL, a second URL, a non-http URL and an unknown flag are refused', () => {
    expect(() => parseArgs([])).toThrow('give the page URL')
    expect(() => parseArgs(['https://a.example.test', 'https://b.example.test'])).toThrow('one URL at a time')
    expect(() => parseArgs(['file:///tmp/index.html'])).toThrow('is not an http(s) URL')
    expect(() => parseArgs(['https://example.test', '--slow'])).toThrow('unknown option --slow')
    expect(() => parseArgs(['https://example.test', '--cdp'])).toThrow('--cdp needs an endpoint')
  })
})

group('live cli: pricing a measured page', () => {
  const results = [
    {
      name: 'desktop',
      viewport: { width: 1280, height: 800 },
      timing: { readyMs: 120 },
      items: [
        { unit: 'word', file: 'src/Card.vue', count: 10 },
        { unit: 'control', file: '(page)', count: 2 },
        { unit: 'color', file: '(page)', count: 8 },
      ],
    },
    {
      name: 'phone',
      viewport: { width: 390, height: 844 },
      timing: { readyMs: 90 },
      items: [{ unit: 'word', file: 'src/Card.vue', count: 4 }],
    },
  ]

  test('points are the weighted counts less the free allowances, per viewport', () => {
    const report = priceReport('https://example.test/', results, priceList({ control: 3 }))
    expect(report.viewports[0].points).toBe(10 + 2 * 3 + 2)
    expect(report.viewports[1].points).toBe(4)
  })

  test('the report is the live shape, with each viewport\'s timing', () => {
    const report = priceReport('https://example.test/', results, priceList({ control: 3 }))
    expect(Object.keys(report).sort()).toEqual(['mode', 'url', 'viewports'])
    expect(report.mode).toBe('live')
    expect(report.viewports[0].timing).toEqual({ readyMs: 120 })
    expect(report.viewports[1].timing).toEqual({ readyMs: 90 })
  })

  test('each viewport attributes its points to files, summing to its total', () => {
    const [desktop] = priceReport('https://example.test/', results, priceList({ control: 3 })).viewports
    const sum = Object.values(desktop.byFile).reduce((n, f) => n + f.points, 0)
    expect(Math.round(sum * 10) / 10).toBe(desktop.points)
    expect(desktop.byFile['src/Card.vue'].points).toBe(10)
  })

  test('the human output names the worst viewport and each viewport\'s biggest files', () => {
    const list = priceList({ control: 3 })
    const text = formatHuman(priceReport('https://example.test/', results, list), list)
    expect(text).toContain('live https://example.test/')
    expect(text).toContain('desktop 1280x800: 18 points:')
    expect(text).toContain('(ready in 120 ms)')
    expect(text).toContain('phone 390x844: 4 points:')
    expect(text).toContain('(ready in 90 ms)')
    expect(text).toContain('src/Card.vue')
    expect(text.trim().endsWith('worst: 18 points')).toBe(true)
  })
})

group('live cli: the price list', () => {
  test('a .pricecheck.json weights override is applied to the list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pricecheck-cli-'))
    try {
      await writeFile(join(dir, '.pricecheck.json'), JSON.stringify({ weights: { control: 1 } }))
      expect((await readPriceList(dir)).control.weight).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('without a .pricecheck.json the default list is used', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pricecheck-cli-'))
    try {
      expect((await readPriceList(dir)).control.weight).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

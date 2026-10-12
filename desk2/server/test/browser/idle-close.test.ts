// The idle close of a headless saved-browser Chrome: it closes only after ten quiet minutes, and any live view,
// visible window, or page a live chat drives resets that clock.

import { describe, expect, test } from 'bun:test'
import { IDLE_CLOSE_MS, makeIdleCloser, type IdleCloseDeps } from '../../src/browser/idle-close'

interface FakeProfile {
  port: number
  headless: boolean
  view: boolean
  pages: { id: string; url: string }[]
  owners: Map<string, { chat: string }>
  up: boolean
}

const MIN = 60_000

function setup(liveness: (owner: string) => boolean | null = () => true) {
  const profiles = new Map<string, FakeProfile>()
  const closed: string[] = []
  const logs: string[] = []
  let t = 0
  const add = (dir: string, port: number, over: Partial<FakeProfile> = {}): FakeProfile => {
    const p: FakeProfile = { port, headless: true, view: false, pages: [{ id: 'p1', url: 'about:blank' }], owners: new Map(), up: true, ...over }
    profiles.set(dir, p)
    return p
  }
  const byPort = (port: number): FakeProfile | undefined => [...profiles.values()].find((p) => p.port === port)
  const deps: IdleCloseDeps = {
    liveBrowser: async (dir) => {
      const p = profiles.get(dir)
      return p && p.up ? { port: p.port } : null
    },
    pages: async (port) => (byPort(port)?.pages ?? []).map((x) => ({ ...x })),
    owners: (dir) => profiles.get(dir)?.owners ?? new Map(),
    headless: (dir) => profiles.get(dir)?.headless ?? false,
    liveView: (port) => byPort(port)?.view ?? false,
    liveness,
    close: async (dir) => {
      const p = profiles.get(dir)
      if (!p) return false
      p.up = false
      closed.push(dir)
      return true
    },
    log: (msg) => logs.push(msg),
  }
  const sweep = makeIdleCloser(deps, () => t)
  const at = async (minutes: number, dirs: string[] = [...profiles.keys()]): Promise<string[]> => {
    t = minutes * MIN
    return sweep(dirs)
  }
  return { add, at, closed, logs, profiles }
}

describe('idle close of a headless profile', () => {
  test('a headless profile with only blank pages is closed after ten quiet minutes, and logged', async () => {
    const s = setup()
    s.add('a', 1)
    expect(await s.at(0)).toEqual([])
    expect(await s.at(9)).toEqual([])
    expect(await s.at(10)).toEqual(['a'])
    expect(s.closed).toEqual(['a'])
    expect(s.logs.length).toBe(1)
    expect(s.logs[0]).toContain('a')
    expect(s.logs[0]).toContain('idle')
    expect(await s.at(11)).toEqual([])
  })

  test('a profile with no pages counts as idle', async () => {
    const s = setup()
    s.add('empty', 2, { pages: [] })
    expect(await s.at(0)).toEqual([])
    expect(await s.at(10)).toEqual(['empty'])
  })

  test('a visible window is never closed, however long it sits', async () => {
    const s = setup()
    s.add('visible', 3, { headless: false })
    expect(await s.at(0)).toEqual([])
    expect(await s.at(120)).toEqual([])
    expect(s.closed).toEqual([])
  })

  test('a profile with no running Chrome is not touched', async () => {
    const s = setup()
    s.add('down', 4, { up: false })
    expect(await s.at(0)).toEqual([])
    expect(await s.at(30)).toEqual([])
    expect(s.closed).toEqual([])
  })
})

describe('what resets the idle clock', () => {
  test('a live view in the Browser pane holds the Chrome open and restarts the clock when it ends', async () => {
    const s = setup()
    const p = s.add('viewed', 5, { view: true })
    expect(await s.at(0)).toEqual([])
    p.view = false
    expect(await s.at(5)).toEqual([])
    expect(await s.at(14)).toEqual([])
    expect(await s.at(15)).toEqual(['viewed'])
  })

  test("a live chat's non-blank page resets the clock until the page is blank again", async () => {
    const s = setup()
    const p = s.add('driven', 6, { pages: [{ id: 'tab', url: 'https://example.com/' }], owners: new Map([['tab', { chat: 'chat-live' }]]) })
    expect(await s.at(0)).toEqual([])
    expect(await s.at(8)).toEqual([])
    p.pages = [{ id: 'tab', url: 'about:blank' }]
    expect(await s.at(9)).toEqual([])
    expect(await s.at(18)).toEqual([])
    expect(await s.at(19)).toEqual(['driven'])
  })

  test('a non-blank page with no ledger row is not idle, since its owner is unknown', async () => {
    const s = setup()
    s.add('unowned', 7, { pages: [{ id: 'x', url: 'https://example.com/' }] })
    expect(await s.at(0)).toEqual([])
    expect(await s.at(30)).toEqual([])
    expect(s.closed).toEqual([])
  })

  test('an owner whose liveness cannot be judged (mcp) keeps its page non-idle', async () => {
    const s = setup(() => null)
    s.add('mcp', 8, { pages: [{ id: 'm', url: 'https://example.com/' }], owners: new Map([['m', { chat: 'mcp:connections' }]]) })
    expect(await s.at(0)).toEqual([])
    expect(await s.at(30)).toEqual([])
  })
})

describe('a dead owner', () => {
  test("a dead owner's leftover non-blank page counts as idle and the Chrome closes after ten minutes", async () => {
    const s = setup((owner) => (owner === 'chat-gone' ? false : true))
    s.add('leftover', 9, { pages: [{ id: 'old', url: 'https://example.com/' }], owners: new Map([['old', { chat: 'chat-gone' }]]) })
    expect(await s.at(0)).toEqual([])
    expect(await s.at(10)).toEqual(['leftover'])
  })
})

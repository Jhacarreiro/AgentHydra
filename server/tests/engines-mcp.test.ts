// The Sue/Dredd and price check MCP servers load the engine that ships in engines/, not a sibling checkout.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT } from '../src/config'
import { loadPriceCheckTools, priceCheckDir } from '../src/mcp-pricecheck'
import { resolveCheckout, sueDreddTools } from '../src/mcp-sue-dredd'

const ENGINES = join(APP_ROOT, 'engines')

describe('the in-repo engines', () => {
  test('ship the Sue, Dredd and price check entry points', () => {
    for (const f of [
      'sue/sue.mjs',
      'dredd/dredd.mjs',
      'pricecheck/mcp/tools.mjs',
      'mcp/server.mjs',
    ])
      expect(existsSync(join(ENGINES, f))).toBe(true)
  })

  test('the Sue and Dredd server resolves the engine in this repo when nothing is set', () => {
    expect(resolveCheckout('sue', {}, APP_ROOT)).toBe(ENGINES)
    expect(resolveCheckout('dredd', {}, APP_ROOT)).toBe(ENGINES)
    expect(sueDreddTools().map((t) => t.name)).toEqual(expect.arrayContaining(['sue', 'dredd']))
  })

  test('the price check server loads engines/pricecheck and lists its tools', async () => {
    const saved = process.env.PRICECHECK_DIR
    delete process.env.PRICECHECK_DIR
    try {
      expect(priceCheckDir()).toBe(join(ENGINES, 'pricecheck'))
    } finally {
      if (saved !== undefined) process.env.PRICECHECK_DIR = saved
    }
    const tools = await loadPriceCheckTools(join(ENGINES, 'pricecheck'), {
      folderOf: async () => ({ cwd: APP_ROOT }),
      postDashboard: async (body) => body,
      callBudgetMs: 1000,
    })
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) expect(typeof t.run).toBe('function')
  })

  test("the engines' own stdio MCP server starts from engines/mcp and lists the sue and dredd tools", async () => {
    const proc = Bun.spawn(['node', join(ENGINES, 'mcp', 'server.mjs')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      cwd: ENGINES,
    })
    const send = (m: unknown) => proc.stdin.write(`${JSON.stringify(m)}\n`)
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    proc.stdin.flush()
    const reader = proc.stdout.getReader()
    let buf = ''
    const seen: Record<number, any> = {}
    const deadline = Date.now() + 30_000
    while (!(seen[1] && seen[2]) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const m = JSON.parse(line)
          if (m.id) seen[m.id] = m
        } catch {}
      }
    }
    proc.kill()
    expect(seen[1].result.serverInfo.name).toBe('sue-dredd')
    const names = seen[2].result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['sue', 'dredd']))
  }, 40_000)
})

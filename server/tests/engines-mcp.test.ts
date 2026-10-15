// The Sue/Dredd and price check MCP doors start the private sue-dredd checkout: SUE_DREDD_HOME, else the one beside AgentHydra.
// The live checks run only on a PC that has that checkout; the scratch-folder checks are in mcp-sue-dredd.test.ts.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { APP_ROOT } from '../src/config'
import { loadPriceCheckTools, priceCheckDir } from '../src/mcp-pricecheck'
import { resolveCheckout, sueDreddTools } from '../src/mcp-sue-dredd'

const BESIDE = join(resolve(APP_ROOT), '..', 'sue-dredd')
const LIVE = existsSync(join(BESIDE, 'sue', 'sue.mjs')) ? BESIDE : null

describe('the sue-dredd door', () => {
  test.skipIf(!LIVE)(
    'the checkout beside AgentHydra ships the Sue, Dredd and price check entry points',
    () => {
      for (const f of [
        'sue/sue.mjs',
        'dredd/dredd.mjs',
        'pricecheck/mcp/tools.mjs',
        'mcp/server.mjs',
      ])
        expect(existsSync(join(LIVE as string, f))).toBe(true)
    },
  )

  test.skipIf(!LIVE)(
    'the Sue and Dredd doors resolve the checkout beside AgentHydra when nothing is set',
    () => {
      const saved = process.env.SUE_DREDD_HOME
      delete process.env.SUE_DREDD_HOME
      try {
        expect(resolveCheckout('sue', {}, APP_ROOT)).toBe(LIVE as string)
        expect(resolveCheckout('dredd', {}, APP_ROOT)).toBe(LIVE as string)
      } finally {
        if (saved !== undefined) process.env.SUE_DREDD_HOME = saved
      }
    },
  )

  test('the tools are listed even when no checkout is on disk', () => {
    expect(sueDreddTools().map((t) => t.name)).toEqual(expect.arrayContaining(['sue', 'dredd']))
  })

  test.skipIf(!LIVE)(
    'the price check door loads pricecheck from the checkout beside AgentHydra and lists its tools',
    async () => {
      const saved = { dir: process.env.PRICECHECK_DIR, home: process.env.SUE_DREDD_HOME }
      delete process.env.PRICECHECK_DIR
      delete process.env.SUE_DREDD_HOME
      try {
        expect(priceCheckDir()).toBe(join(LIVE as string, 'pricecheck'))
      } finally {
        if (saved.dir !== undefined) process.env.PRICECHECK_DIR = saved.dir
        if (saved.home !== undefined) process.env.SUE_DREDD_HOME = saved.home
      }
      const tools = await loadPriceCheckTools(join(LIVE as string, 'pricecheck'), {
        folderOf: async () => ({ cwd: APP_ROOT }),
        postDashboard: async (body) => body,
        callBudgetMs: 1000,
      })
      expect(tools.length).toBeGreaterThan(0)
      for (const t of tools) expect(typeof t.run).toBe('function')
    },
  )

  test.skipIf(!LIVE)(
    "the checkout's own stdio MCP server starts and lists the sue and dredd tools",
    async () => {
      const proc = Bun.spawn(['node', join(LIVE as string, 'mcp', 'server.mjs')], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
        cwd: LIVE as string,
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
    },
    40_000,
  )
})

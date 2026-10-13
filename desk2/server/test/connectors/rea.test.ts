import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorStatus } from '../../../shared/connectors'
import { createRegistry, loadDefs } from '../../src/connectors/registry'
import factory from '../../src/connectors/defs/rea'

const root = mkdtempSync(join(tmpdir(), 'rea-conn-'))
const home = join(root, 'desk')
const DEFS = join(import.meta.dir, '..', '..', 'src', 'connectors', 'defs')
const savedEnv = { hydra: process.env.HYDRA_URL, path: process.env.PATH, pathext: process.env.PATHEXT }

let daemon: ReturnType<typeof Bun.serve> | null = null
let hubServes = false

beforeAll(() => {
  daemon = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path === '/api/mcp/shared/rea' && hubServes) return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
      return new Response('no', { status: 404 })
    },
  })
  process.env.HYDRA_URL = `http://127.0.0.1:${daemon.port}`
  process.env.PATHEXT = '.CMD'
  process.env.PATH = join(root, 'empty')
})

afterEach(() => {
  hubServes = false
  process.env.PATH = join(root, 'empty')
  rmSync(join(root, 'empty'), { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  daemon?.stop(true)
  for (const [k, v] of [['HYDRA_URL', savedEnv.hydra], ['PATH', savedEnv.path], ['PATHEXT', savedEnv.pathext]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

const def = () => factory({ home })
const sharedUrl = () => `http://127.0.0.1:${daemon?.port}/api/mcp/shared/rea`
const status = (over: Partial<ConnectorStatus>): ConnectorStatus => ({ id: 'rea', state: 'running', url: null, version: null, enabled: true, givesChats: true, checkedAt: 0, ...over })

function putRea(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rea.cmd'), '@echo off\r\n')
}

describe('detect', () => {
  test('running at the hub URL when the shared hub serves an entry named rea', async () => {
    hubServes = true
    expect(await def().detect()).toEqual({ state: 'running', url: sharedUrl(), version: null })
  })

  test('running as stdio when a rea command is on PATH and the hub serves nothing', async () => {
    putRea(join(root, 'empty'))
    expect(await def().detect()).toEqual({ state: 'running', url: null, version: null })
  })

  test('absent, with the install line, when neither the hub nor PATH has it', async () => {
    expect(await def().detect()).toEqual({
      state: 'absent',
      url: null,
      version: null,
      reason: 'Not installed: npm i -g rea-agents (github.com/morluto/rea)',
    })
  })
})

describe('chat', () => {
  test('the hub entry as an http server, with the prompt', async () => {
    hubServes = true
    const got = def().chat!('C:/Users/me/proj', status({ url: sharedUrl() }))
    expect(got?.mcpServers).toEqual({ rea: { type: 'http', url: sharedUrl() } })
    expect(got?.prompt).toContain('mcp__rea__analyze_web_bundle')
    expect(got?.prompt).toContain('Never run `rea setup` or `rea update`')
  })

  test('the PATH command as a stdio server', async () => {
    putRea(join(root, 'empty'))
    const got = def().chat!('C:/Users/me/proj', status({}))
    expect(got?.mcpServers).toEqual({ rea: { type: 'stdio', command: 'rea', args: ['mcp'] } })
  })

  test('nothing when REA is not running', async () => {
    expect(def().chat!('C:/Users/me/proj', status({ state: 'absent', givesChats: false }))).toBeNull()
  })
})

describe('registry', () => {
  test('the connector file loads and the list carries rea with its install line', async () => {
    const defs = await loadDefs(DEFS, home)
    expect(defs.map((d) => d.info.id)).toContain('rea')
    const registry = createRegistry({ home, defs: defs.filter((d) => d.info.id === 'rea'), pollMs: 60_000 })
    await registry.refresh()
    const rea = registry.list().find((v) => v.id === 'rea')
    expect(rea).toMatchObject({ name: 'REA', homepage: 'https://github.com/morluto/rea', installable: false, pane: false, state: 'absent' })
    registry.stop()
  })
})

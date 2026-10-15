// The stdio MCP server: a spawned `pricecheck mcp` speaks JSON-RPC 2.0, one message per line, and nothing else on stdout.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, describe as group, beforeAll, afterAll } from 'bun:test'

const ROOT = join(import.meta.dirname, '..', '..')
const BIN = join(ROOT, 'bin', 'pricecheck.mjs')
const FIXTURE = join(ROOT, 'test', 'fixtures', 'vue')

let home
let project

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'pricecheck-server-'))
  project = join(home, 'vue')
  cpSync(FIXTURE, project, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project })
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const talk = (messages) =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: { ...process.env, PRICECHECK_HOME: home },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', fail)
    child.on('close', (code) => done({ code, out, err, lines: out.split('\n').filter(Boolean) }))
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join('\n') + '\n')
  })

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params })

group('pricecheck mcp', () => {
  test('initialize echoes the protocol version and names the server', async () => {
    const res = await talk([request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })])
    const reply = JSON.parse(res.lines[0])
    expect(reply.id).toBe(1)
    expect(reply.result.protocolVersion).toBe('2025-06-18')
    expect(reply.result.serverInfo.name).toBe('pricecheck')
    expect(reply.result.capabilities.tools).toBeDefined()
  })

  test('notifications get no reply, and ping is answered', async () => {
    const res = await talk([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      request(2, 'ping'),
    ])
    expect(res.lines.length).toBe(1)
    expect(JSON.parse(res.lines[0])).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
  })

  test('tools/list names the seven tools with their schemas', async () => {
    const res = await talk([request(3, 'tools/list')])
    const tools = JSON.parse(res.lines[0]).result.tools
    expect(tools.map((t) => t.name)).toEqual([
      'price_check',
      'price_check_next',
      'price_check_live',
      'price_check_freeze',
      'price_check_report',
      'price_check_advice',
      'price_check_feedback',
    ])
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  test('tools/call price_check scans the fixture and returns a priced page as text JSON', async () => {
    const res = await talk([
      request(4, 'tools/call', {
        name: 'price_check',
        arguments: { cwd: project, mode: 'scan', limit: 5 },
      }),
    ])
    const reply = JSON.parse(res.lines[0])
    expect(reply.result.isError).toBeFalsy()
    expect(reply.result.content[0].type).toBe('text')
    const body = JSON.parse(reply.result.content[0].text)
    expect(body.pagesTotal).toBeGreaterThan(0)
    expect(body.pages[0].points).toBeGreaterThan(0)
    expect(typeof body.pages[0].page).toBe('string')
  })

  test('a bad call comes back as isError and the server keeps answering', async () => {
    const res = await talk([
      request(5, 'tools/call', { name: 'price_check', arguments: { cwd: project, mode: 'nope' } }),
      request(6, 'tools/call', { name: 'no_such_tool', arguments: {} }),
      request(7, 'ping'),
    ])
    expect(res.code).toBe(0)
    const [first, second, third] = res.lines.map((l) => JSON.parse(l))
    expect(first.id).toBe(5)
    expect(first.result.isError).toBe(true)
    expect(first.result.content[0].text).toMatch(/mode/)
    expect(second.id).toBe(6)
    expect(second.result.isError).toBe(true)
    expect(third).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  test('an unknown method is a JSON-RPC error, not a crash', async () => {
    const res = await talk([request(8, 'resources/list')])
    const reply = JSON.parse(res.lines[0])
    expect(reply.id).toBe(8)
    expect(reply.error.code).toBe(-32601)
  })

  test('stdout carries only JSON-RPC lines; logs go to stderr', async () => {
    const res = await talk([
      request(9, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
      request(10, 'tools/call', { name: 'price_check', arguments: { cwd: project, mode: 'nope' } }),
    ])
    for (const line of res.lines) {
      const msg = JSON.parse(line)
      expect(msg.jsonrpc).toBe('2.0')
    }
    expect(res.lines.length).toBe(2)
  })
})

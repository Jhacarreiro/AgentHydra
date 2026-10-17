// Reading one source of a project dashboard (shared/project-dashboard.ts): an MCP tool call or an HTTP GET, answered
// with a feed. An MCP source names a server of the person's Claude config (~/.claude.json mcpServers, the project's
// entry there, or the checkout's .mcp.json), so a spec carries a name and never an address; an http server is spoken to
// as Claude Code does (its headersHelper run in the project folder), a stdio one is started hidden for the one call.
//
// Header values may carry a credential: they are never logged, thrown in a message or returned.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceSpec } from '@shared/project-dashboard'
import { defaultConfigFile } from '../connectors/connections-client'
import { httpConfig, runHeadersHelper, sseMessage } from '../connectors/connections-http'

export const READ_TIMEOUT_MS = 90_000
const MAX_BYTES = 5 * 1024 * 1024
const PROTOCOL = '2025-03-26'

export class SourceError extends Error {}

/** "MCP connections-local · connections_execute" or "HTTP example.com": what the page names a source by. */
export function sourceLabel(s: SourceSpec): string {
  if ('mcp' in s) return `MCP ${s.mcp.server} · ${s.mcp.tool}`
  try {
    return `HTTP ${new URL(s.http.url).host}`
  } catch {
    return 'HTTP'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const sameFolder = (a: string, b: string): boolean => {
  const k = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? k(a).toLowerCase() === k(b).toLowerCase() : k(a) === k(b)
}

/** The config entry for an MCP server name, as Claude Code finds it for this project: the checkout's .mcp.json, the project's own entry, then the global one. */
export function mcpServerEntry(name: string, workspace: string, configFile = defaultConfigFile()): Record<string, unknown> | null {
  const local = readJson(join(workspace, '.mcp.json'))
  const fromLocal = isObj(local) && isObj(local.mcpServers) ? local.mcpServers[name] : undefined
  if (isObj(fromLocal)) return fromLocal
  const config = readJson(configFile)
  if (!isObj(config)) return null
  if (isObj(config.projects))
    for (const [path, p] of Object.entries(config.projects))
      if (sameFolder(path, workspace) && isObj(p) && isObj(p.mcpServers) && isObj(p.mcpServers[name])) return p.mcpServers[name] as Record<string, unknown>
  const global = isObj(config.mcpServers) ? config.mcpServers[name] : undefined
  return isObj(global) ? global : null
}

/** The feed in an MCP tool result: its structuredContent, else the first text part that is (or holds) a JSON object with sections. */
export function feedFromToolResult(result: unknown): unknown {
  if (!isObj(result)) throw new SourceError('the tool gave no result')
  if (isObj(result.structuredContent) && 'sections' in result.structuredContent) return result.structuredContent
  const texts = (Array.isArray(result.content) ? result.content : [])
    .map((c) => (isObj(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
  if (result.isError === true) throw new SourceError(`the tool refused: ${(texts[0] ?? 'no reason given').slice(0, 300)}`)
  for (const t of texts) {
    const found = jsonObjectIn(t)
    if (isObj(found) && 'sections' in found) return found
  }
  throw new SourceError('the tool answered, but not with a dashboard feed (a JSON object with sections)')
}

/** The text as JSON, or the first balanced {...} in it that parses (a tool may wrap its JSON in a line of prose). */
export function jsonObjectIn(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // not JSON as a whole: look for an object inside
  }
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (ch === '\\') i++
        else if (ch === '"') inString = false
      } else if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          break
        }
      }
    }
  }
  return null
}

async function postRpc(url: string, headers: Record<string, string>, session: string | null, body: object, wantId: number | null, signal: AbortSignal): Promise<{ session: string | null; result: unknown }> {
  const h: Record<string, string> = { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (session) {
    h['mcp-session-id'] = session
    h['mcp-protocol-version'] = PROTOCOL
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal })
  } catch {
    throw new SourceError(`the MCP server did not answer at ${new URL(url).host}`)
  }
  const sid = res.headers.get('mcp-session-id') ?? session
  if (wantId === null) return { session: sid, result: null }
  if (!res.ok) throw new SourceError(`the MCP server answered HTTP ${res.status}`)
  const text = await res.text()
  const msg = ((res.headers.get('content-type') ?? '').includes('text/event-stream') ? sseMessage(text, wantId) : jsonObjectIn(text)) as {
    result?: unknown
    error?: { message?: string }
  } | null
  if (!msg) throw new SourceError('the MCP server sent no answer')
  if (msg.error) throw new SourceError(`the MCP server refused: ${String(msg.error.message ?? 'no reason').slice(0, 300)}`)
  return { session: sid, result: msg.result }
}

async function callHttpMcp(entry: Record<string, unknown>, name: string, tool: string, args: Record<string, unknown>, workspace: string): Promise<unknown> {
  const cfg = httpConfig(entry, name)
  if (!cfg) throw new SourceError(`the MCP server ${name} has no http url`)
  const headers = await runHeadersHelper(cfg, workspace, null).catch(() => {
    throw new SourceError(`the headers helper of ${name} failed`)
  })
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
  const init = await postRpc(cfg.url, headers, null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agenthydra-dashboard', version: '1' } } }, 1, signal)
  const session = init.session
  try {
    await postRpc(cfg.url, headers, session, { jsonrpc: '2.0', method: 'notifications/initialized' }, null, signal)
    const call = await postRpc(cfg.url, headers, session, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }, 2, signal)
    return feedFromToolResult(call.result)
  } finally {
    if (session)
      void fetch(cfg.url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session }, signal: AbortSignal.timeout(2000) }).catch(() => {
        // floor-ok: the server is gone or already forgot the session
      })
  }
}

/** One call to a stdio MCP server: started hidden in the project folder, initialized, asked once, ended. */
function callStdioMcp(entry: Record<string, unknown>, name: string, tool: string, args: Record<string, unknown>, workspace: string): Promise<unknown> {
  const command = typeof entry.command === 'string' ? entry.command : ''
  if (!command) return Promise.reject(new SourceError(`the MCP server ${name} has no command`))
  const argv = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : []
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: workspace }
  if (isObj(entry.env)) for (const [k, v] of Object.entries(entry.env)) if (typeof v === 'string') env[k] = v
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: workspace, env: env as NodeJS.ProcessEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32' && !/\.exe$/i.test(command) })
    let buf = ''
    let done = false
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new SourceError(`the MCP server ${name} did not answer in ${READ_TIMEOUT_MS / 1000} s`)), READ_TIMEOUT_MS)
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`)
    child.on('error', () => finish(new SourceError(`the MCP server ${name} could not start`)))
    child.on('exit', (code) => finish(new SourceError(`the MCP server ${name} exited (${code}) before it answered`)))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      buf += d
      if (buf.length > MAX_BYTES) return finish(new SourceError(`the MCP server ${name} answered over ${MAX_BYTES} bytes`))
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: { id?: unknown; result?: unknown; error?: { message?: string } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          if (msg.error) return finish(new SourceError(`the MCP server ${name} refused to start: ${String(msg.error.message ?? '').slice(0, 200)}`))
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } })
        } else if (msg.id === 2) {
          if (msg.error) return finish(new SourceError(`the MCP server refused: ${String(msg.error.message ?? '').slice(0, 300)}`))
          try {
            finish(null, feedFromToolResult(msg.result))
          } catch (err) {
            finish(err as Error)
          }
        }
      }
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agenthydra-dashboard', version: '1' } } })
  })
}

/** ${env:NAME} in a header value, from the environment; a name that is not set leaves the header out. */
export function expandHeaders(headers: Record<string, string> | undefined, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    let unset = false
    const value = v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => {
      const got = env[n]
      if (got === undefined) unset = true
      return got ?? ''
    })
    if (!unset) out[k] = value
  }
  return out
}

async function getHttp(url: string, headers: Record<string, string> | undefined): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...expandHeaders(headers) }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
  } catch {
    throw new SourceError(`${new URL(url).host} did not answer`)
  }
  if (!res.ok) throw new SourceError(`${new URL(url).host} answered HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new SourceError(`${new URL(url).host} answered over ${MAX_BYTES} bytes`)
  try {
    return JSON.parse(text)
  } catch {
    throw new SourceError(`${new URL(url).host} did not answer JSON`)
  }
}

/** Reads one source; resolves its raw answer (checked by the caller) or rejects with a SourceError saying why. */
export async function readSource(source: SourceSpec, workspace: string): Promise<unknown> {
  if ('http' in source) return getHttp(source.http.url, source.http.headers)
  const { server, tool } = source.mcp
  const entry = mcpServerEntry(server, workspace)
  if (!entry) throw new SourceError(`no MCP server named ${server} in your Claude config`)
  const args = source.mcp.arguments ?? {}
  return entry.type === 'http' || (entry.type === undefined && typeof entry.url === 'string')
    ? callHttpMcp({ ...entry, type: 'http' }, server, tool, args, workspace)
    : callStdioMcp(entry, server, tool, args, workspace)
}

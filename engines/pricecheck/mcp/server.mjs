// The pricecheck MCP server over stdio: one JSON-RPC 2.0 message per line in, one per line out. Logs go to stderr only.
import { createInterface } from 'node:readline'
import { pricecheckVersion } from '../lib/advice/log.mjs'

const PROTOCOL_VERSION = '2025-06-18'
const PARSE_ERROR = -32700
const METHOD_NOT_FOUND = -32601

export function serve({
  input = process.stdin,
  output = process.stdout,
  log = (line) => process.stderr.write(`${line}\n`),
  tools,
}) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const send = (message) => output.write(`${JSON.stringify(message)}\n`)
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
  const text = (value, isError = false) => ({
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  })

  async function callTool(id, params = {}) {
    const tool = byName.get(params.name)
    if (!tool) return result(id, text(`unknown tool: ${params.name}`, true))
    try {
      return result(id, text(await tool.run(params.arguments ?? {})))
    } catch (error) {
      log(`${params.name}: ${error.message}`)
      return result(id, text(error.message, true))
    }
  }

  async function handle(message) {
    const { id, method, params } = message
    if (id === undefined) return
    if (method === 'initialize') {
      return result(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'pricecheck', version: pricecheckVersion() },
      })
    }
    if (method === 'ping') return result(id, {})
    if (method === 'tools/list') {
      return result(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })
    }
    if (method === 'tools/call') return callTool(id, params)
    send({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } })
  }

  let queue = Promise.resolve()
  const rl = createInterface({ input })
  return new Promise((done) => {
    rl.on('line', (line) => {
      if (!line.trim()) return
      queue = queue.then(async () => {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error' } })
          return
        }
        await handle(message)
      })
    })
    rl.on('close', () => queue.then(done))
  })
}

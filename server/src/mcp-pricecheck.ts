// Loads the owners' private page price checker when its checkout is present; without it, AgentHydra has no price check tools.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { callAddon } from './addon-loader'
import { APP_ROOT } from './config'
import { api, type HydraTool, JSON_HEADERS, MCP_CALL_BUDGET_MS } from './mcp-client'
import { folderOf } from './mcp-dashboards'
import { sueDreddCandidates } from './sue-dredd-home'

export interface PriceCheckHost {
  folderOf: (args: Record<string, unknown>) => Promise<{ cwd: string }>
  postDashboard: (body: unknown) => Promise<unknown>
  callBudgetMs: number
}

const postDashboard = (body: unknown) =>
  api('/api/dashboards/workspace', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

const LIVE_HOST: PriceCheckHost = { folderOf, postDashboard, callBudgetMs: MCP_CALL_BUDGET_MS }

export function priceCheckDir(): string {
  const fromEnv = process.env.PRICECHECK_DIR?.trim()
  if (fromEnv) return fromEnv
  const candidates = sueDreddCandidates(process.env, APP_ROOT).map((h) => join(h, 'pricecheck'))
  return candidates.find((d) => existsSync(join(d, 'mcp', 'tools.mjs'))) ?? candidates[0]
}

export async function loadPriceCheckTools(
  dir: string,
  host: PriceCheckHost = LIVE_HOST,
): Promise<HydraTool[]> {
  const tools = await callAddon<HydraTool[]>(join(dir, 'mcp', 'tools.mjs'), 'priceCheckTools', host)
  return (tools ?? []).map(({ name, description, inputSchema, listed, callerChat, run }) => ({
    name,
    description,
    inputSchema,
    listed,
    callerChat,
    run,
  }))
}

export const PRICECHECK_TOOLS: HydraTool[] = await loadPriceCheckTools(priceCheckDir())

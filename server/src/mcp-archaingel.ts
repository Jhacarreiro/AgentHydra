// server/src/mcp-archaingel.ts - the `archaingel` MCP tool: the standing agents ArchAIngel runs (each registered with a file
// in <desk home>/archaingel/agents), each one's state and why, its headline and counts, when it last ran and how, and when
// it is due next. ArchAIngel lives in AgentHydra 2.0 (Desk, desk2/server/src/plugins/73-archaingel.ts), so this file keeps
// no state: it reads Desk's /api/archaingel, which answers from its last look (no model asked), and turns its times into ISO.
import { desk2Present, desk2Url } from './desk2'
import { type HydraTool, S } from './mcp-client'

// The parts of desk2/shared/archaingel.ts this reads. Not imported: a release build may carry no desk2/.
interface Run {
  startedAt: number
  endedAt: number
  outcome: string
  exitCode: number | null
  lastLine: string
}
interface Agent {
  id: string
  name: string
  state: string
  reason: string
  headline: string | null
  totals: Record<string, number> | null
  lastTickAt: number | null
  nextTickAt: number | null
  running: { startedAt: number; pid: number | null } | null
  runs: Run[]
}
interface Status {
  enabled: boolean
  checkedAt: number | null
  nextCheckAt: number | null
  agents: Agent[]
  error: string | null
}

const RUNS_SHOWN = 5
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

async function archaingel(args: {
  fresh?: boolean
  enabled?: boolean
  run?: string
}): Promise<unknown> {
  if (!desk2Present())
    throw new Error(
      'ArchAIngel lives in AgentHydra 2.0 (desk2/), which this install does not have.',
    )
  const base = desk2Url()
  const mutates = typeof args.enabled === 'boolean' || typeof args.run === 'string'
  let res: Response
  try {
    res = mutates
      ? await fetch(`${base}/api/archaingel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
            ...(typeof args.run === 'string' ? { run: args.run } : {}),
          }),
          signal: AbortSignal.timeout(90_000),
        })
      : await fetch(`${base}/api/archaingel${args.fresh ? '?fresh=1' : ''}`, {
          signal: AbortSignal.timeout(90_000),
        })
  } catch {
    throw new Error(
      `AgentHydra's window (Desk 2, ${base}) is not answering. ArchAIngel runs there: open AgentHydra, then call again.`,
    )
  }
  const json = (await res.json().catch(() => null)) as (Status & { error?: string }) | null
  if (!res.ok || !json)
    throw new Error(
      res.status === 404 && !mutates
        ? 'This AgentHydra window predates ArchAIngel: restart it (Restart to update in its menu).'
        : (json?.error ?? `HTTP ${res.status}`),
    )
  return {
    enabled: json.enabled,
    checkedAt: iso(json.checkedAt),
    nextCheckAt: iso(json.nextCheckAt),
    agents: json.agents.map((a) => ({
      id: a.id,
      name: a.name,
      state: a.state,
      reason: a.reason,
      headline: a.headline,
      totals: a.totals,
      lastTickAt: iso(a.lastTickAt),
      nextTickAt: iso(a.nextTickAt),
      running: a.running ? { startedAt: iso(a.running.startedAt), pid: a.running.pid } : null,
      recent: a.runs
        .slice(0, RUNS_SHOWN)
        .map((r) => ({ ...r, startedAt: iso(r.startedAt), endedAt: iso(r.endedAt) })),
    })),
    error: json.error,
  }
}

export const ARCHAINGEL_TOOLS: HydraTool[] = [
  {
    name: 'archaingel',
    description:
      "ArchAIngel's standing agents, right now: each one registered with a file in AgentHydra's archaingel/agents folder, with its state (idle, due, running, off, or broken, and why), its headline and counts from its own status command, when it last ran and how (ok, busy, failed, timed-out or interrupted, with the last output line), its running tick if any, and when it is due next; plus whether ArchAIngel is on, when it last looked and when it looks next. ArchAIngel looks every 5 minutes and ticks each agent on its own pace (at least 15 minutes apart) through hidden processes, asking no model itself. Answers from its last look in milliseconds; `fresh` looks first (each agent's status command runs). MUTATES only with `enabled` (turns ArchAIngel on or off; on by default) and `run` (ticks one agent now, skipping its due time, which refuses an off, broken or running agent).",
    inputSchema: S({
      fresh: { type: 'boolean', description: 'Look now before answering.' },
      enabled: {
        type: 'boolean',
        description: 'MUTATES: turn ArchAIngel on (true) or off (false).',
      },
      run: { type: 'string', description: 'MUTATES: the id of one standing agent to tick now.' },
    }),
    run: (args) => archaingel(args as { fresh?: boolean; enabled?: boolean; run?: string }),
  },
]

// server/src/mcp-find.ts - the two tools that make AgentHydra's ~130 tools findable and the Desk window drivable.
//
// hydra_find: search every AgentHydra tool by what you want done, the way the Connections MCP's catalog search
// works. An agent sees only tool NAMES until it loads a schema, and with this many names a plain-word ask
// ("move this chat to another workspace") never meets the tool that does it. Measured 2026-10-11: an agent asked to
// switch a Desk chat's workspace opened a second chat instead, because nothing it could see said "folder".
//
// desk_move_chat: move a Hydra Desk chat (the AgentHydra 2.0 window) to another folder, the one thing that until
// now was only a sentence in the Desk system prompt (PATCH /api/chats/:id {cwd}). move_chat moves a chat between
// ACCOUNTS and move_chat_folder moves a Claude DESKTOP chat; neither touches a Desk chat.
import { existsSync, statSync } from 'node:fs'
import { S, str } from './mcp-client'
import type { McpEngineTool } from './mcp-stdio.mjs'

/** Words an agent says, mapped to the words the tool texts use. */
const SYNONYMS: Record<string, string[]> = {
  workspace: ['folder', 'cwd', 'project'],
  folder: ['workspace', 'cwd', 'project'],
  project: ['folder', 'workspace'],
  directory: ['folder', 'cwd'],
  switch: ['move', 'change'],
  change: ['move', 'switch', 'set'],
  account: ['instance'],
  instance: ['account'],
  quota: ['usage', 'limit'],
  usage: ['quota', 'limit'],
  conversation: ['chat', 'session'],
  chat: ['session'],
  session: ['chat'],
  delete: ['remove', 'archive'],
  spawn: ['fan', 'launch', 'start'],
  parallel: ['fan'],
  server: ['dev'],
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'and',
  'or',
  'for',
  'my',
  'this',
  'that',
  'it',
  'is',
  'i',
  'me',
  'with',
  'how',
  'do',
  'can',
])

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
}

/** The first sentence of a description, without the MUTATES: tag, for a one-line summary. */
function summary(description: string): string {
  const d = description.replace(/^MUTATES:\s*/, '').replace(/^READ-ONLY:\s*/, '')
  const end = d.search(/[.!?](\s|$)/)
  const s = end > 0 ? d.slice(0, end + 1) : d
  return s.length > 220 ? `${s.slice(0, 217)}...` : s
}

export interface FoundTool {
  name: string
  score: number
  mutates: boolean
  summary: string
  required: string[]
}

/** Ranks tools for a plain-words ask: a word in the name counts most, then in the first sentence, then anywhere. */
export function rankTools(tools: McpEngineTool[], query: string, limit = 8): FoundTool[] {
  const asked = words(query)
  const terms = new Map<string, number>()
  for (const w of asked) {
    terms.set(w, Math.max(terms.get(w) ?? 0, 1))
    for (const s of SYNONYMS[w] ?? []) terms.set(s, Math.max(terms.get(s) ?? 0, 0.6))
  }
  const out: FoundTool[] = []
  for (const t of tools) {
    const name = new Set(words(t.name.replace(/_/g, ' ')))
    const desc = t.description ?? ''
    const first = new Set(words(summary(desc)))
    const all = new Set(words(desc))
    let score = 0
    for (const [w, weight] of terms) {
      if (name.has(w)) score += 5 * weight
      else if (first.has(w)) score += 2 * weight
      else if (all.has(w)) score += 0.5 * weight
    }
    if (score <= 0) continue
    const schema = t.inputSchema as { required?: string[] } | undefined
    out.push({
      name: t.name,
      score: Math.round(score * 10) / 10,
      mutates: /^MUTATES:/.test(desc),
      summary: summary(desc),
      required: schema?.required ?? [],
    })
  }
  return out
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, limit))
}

/** The Desk window's address on this PC. */
export function deskBase(): string {
  return `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`
}

interface DeskChat {
  id: string
  sessionId?: string | null
  title?: string
  cwd?: string
  status?: string
}

/** One Desk chat from its Desk id, its Claude session id, or a title fragment (refuses an ambiguous fragment). */
export function pickDeskChat(chats: DeskChat[], ref: string): DeskChat {
  const r = ref.trim()
  const exact = chats.find((c) => c.id === r || c.sessionId === r)
  if (exact) return exact
  const low = r.toLowerCase()
  const hits = chats.filter((c) => (c.title ?? '').toLowerCase().includes(low))
  if (hits.length === 1) return hits[0]
  if (!hits.length)
    throw new Error(
      `no Desk chat matches "${r}" (pass its Desk chat id, its session id, or part of its title)`,
    )
  throw new Error(
    `"${r}" matches ${hits.length} Desk chats: ${hits
      .slice(0, 6)
      .map((c) => `${c.id} "${c.title}"`)
      .join('; ')}; pass the id`,
  )
}

export function findTools(getTools: () => McpEngineTool[]): McpEngineTool[] {
  return [
    {
      name: 'hydra_find',
      description:
        "FIND THE AGENTHYDRA TOOL FOR A JOB: say what you want in plain words ('move this chat to another workspace', " +
        "'which account has quota left', 'run this on another account', 'start a dev server') and get the matching tools, " +
        'best first, each with a one-line summary, whether it MUTATES, and its required parameters. AgentHydra has over a ' +
        'hundred tools and you see only their names; search here before deciding a thing cannot be done or reaching ' +
        'for a workaround.',
      inputSchema: S(
        {
          query: { type: 'string', description: 'What you want done, in plain words.' },
          limit: { type: 'number', description: 'How many tools to return (default 8).' },
        },
        ['query'],
      ),
      run: async (a) => {
        const query = str(a.query).trim()
        if (!query) throw new Error('query is required: say what you want done')
        const limit =
          Number.isFinite(Number(a.limit)) && Number(a.limit) > 0 ? Math.floor(Number(a.limit)) : 8
        const tools = rankTools(getTools(), query, limit)
        return {
          query,
          tools,
          note: tools.length
            ? 'Load a tool before calling it (in Claude Code: ToolSearch "select:mcp__agenthydra__<name>").'
            : 'Nothing matched: try other words (what it acts on: chat, account, folder, quota, server).',
        }
      },
    },
    {
      name: 'desk_move_chat',
      description:
        'MUTATES: move a Hydra Desk chat (the AgentHydra 2.0 window) to another folder, which is how its WORKSPACE ' +
        'changes: the sidebar group, the project it works in, and the workspace-scoped tools (saved browsers, the ' +
        "Connections workspace) that follow the folder. `chat` is the Desk chat id (Desk's system prompt names it), its " +
        'Claude session id, or part of its title. The chat keeps its transcript and id; its tools pick up the new folder ' +
        'when its next turn starts. Not for Claude DESKTOP chats (move_chat_folder) or for moving a chat to another ' +
        'ACCOUNT (move_chat).',
      inputSchema: S(
        {
          chat: {
            type: 'string',
            description: 'Desk chat id, Claude session id, or a title fragment.',
          },
          cwd: {
            type: 'string',
            description: 'The new folder: an absolute path to an existing folder.',
          },
        },
        ['chat', 'cwd'],
      ),
      run: async (a) => {
        const cwd = str(a.cwd).trim()
        if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory())
          throw new Error(`no folder at ${cwd || '(empty)'}`)
        const base = deskBase()
        const listed = await fetch(`${base}/api/chats`).catch(() => null)
        if (!listed?.ok)
          throw new Error(`the Desk window does not answer at ${base}; is AgentHydra 2.0 open?`)
        const chat = pickDeskChat((await listed.json()) as DeskChat[], str(a.chat))
        const res = await fetch(`${base}/api/chats/${encodeURIComponent(chat.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd }),
        })
        const body = (await res.json().catch(() => ({}))) as DeskChat & { error?: string }
        if (!res.ok) throw new Error(`Desk refused the move: ${body.error ?? res.status}`)
        return {
          id: body.id ?? chat.id,
          title: body.title ?? chat.title,
          from: chat.cwd,
          cwd: body.cwd,
          note: "Its tools see the new folder from the chat's next turn.",
        }
      },
    },
  ]
}

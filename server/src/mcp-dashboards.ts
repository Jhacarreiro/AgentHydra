// server/src/mcp-dashboards.ts - dashboard_read and dashboard_write: the small dashboard a person sees for a project in
// AgentHydra. Both call the daemon's /api/dashboards routes; the folder defaults to the calling Desk chat's, as desk_chat's does.
import { api, JSON_HEADERS, S, str } from './mcp-client'
import { deskBase, pickDeskChat } from './mcp-find'
import type { McpEngineTool } from './mcp-stdio.mjs'

interface DeskChat {
  id: string
  sessionId?: string | null
  title?: string
  cwd?: string
}

/** The Desk chat that is calling (its id from the connection or the environment), or null when none is known. */
async function callingChat(deskChat: unknown): Promise<DeskChat | null> {
  const ref = str(deskChat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim() || ''
  if (!ref) return null
  try {
    const res = await fetch(`${deskBase()}/api/chats`)
    if (!res.ok) return null
    const chats: unknown = await res.json()
    if (!Array.isArray(chats)) return null
    return pickDeskChat(chats as DeskChat[], ref)
  } catch {
    return null
  }
}

const NO_FOLDER =
  'no folder to use: pass cwd, the working folder you are in (any folder inside the project); this process is not a Desk chat, so none is known'

async function folderOf(
  a: Record<string, unknown>,
): Promise<{ cwd: string; chat: DeskChat | null }> {
  const chat = await callingChat(a.deskChat)
  const cwd = str(a.cwd).trim() || chat?.cwd || ''
  if (!cwd) throw new Error(NO_FOLDER)
  return { cwd, chat }
}

const WIDGET_ITEM = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Slug you pick, 1-64 chars: lowercase letters, digits, "-" or "_". Writing the same id replaces that widget.',
    },
    kind: { type: 'string', enum: ['stat', 'list', 'note', 'progress', 'chart'] },
    title: { type: 'string', description: 'Shown on the widget, up to 80 characters.' },
    order: {
      type: 'number',
      description: 'Lower comes first; widgets without one come last, oldest first.',
    },
    size: {
      type: 'string',
      enum: ['small', 'wide'],
      description:
        'small = a third of the row, wide = the full row. Default: small for stat and progress, wide otherwise.',
    },
    value: { description: 'stat: the number or text to show (required for stat).' },
    unit: { type: 'string', description: 'stat: unit shown after the value, e.g. "%" or "open".' },
    delta: { type: 'string', description: 'stat: change text, e.g. "+3 today".' },
    tone: {
      type: 'string',
      enum: ['good', 'bad', 'warn', 'neutral'],
      description: 'stat or list item colour.',
    },
    caption: { type: 'string', description: 'stat: a line under the value.' },
    items: {
      type: 'array',
      maxItems: 50,
      description:
        'list (also for links): required for list. Each {text, detail?, href?, tone?, done?}.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          detail: { type: 'string' },
          href: { type: 'string', description: 'An http(s) link or a file path.' },
          tone: { type: 'string', enum: ['good', 'bad', 'warn', 'neutral'] },
          done: { type: 'boolean' },
        },
        required: ['text'],
      },
    },
    text: {
      type: 'string',
      description: 'note: markdown, up to 8000 characters (required for note).',
    },
    current: { type: 'number', description: 'progress: the done amount (required with max).' },
    max: { type: 'number', description: 'progress: the total (required with current).' },
    series: {
      type: 'array',
      maxItems: 4,
      description: 'chart: required for chart. Each {label?, points: [numbers, up to 200]}.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          points: { type: 'array', items: { type: 'number' }, maxItems: 200 },
        },
        required: ['points'],
      },
    },
    labels: {
      type: 'array',
      items: { type: 'string' },
      description: 'chart: x-axis labels, one per point.',
    },
  },
  required: ['id', 'kind', 'title'],
}

export const DASHBOARD_TOOLS: McpEngineTool[] = [
  {
    name: 'dashboard_read',
    description:
      'READ-ONLY: the small dashboard the person sees for this project in AgentHydra: its widgets (stat, list, note, progress, chart) with their ids, values and who last wrote each. Read it before changing it. `cwd` is any folder inside the project; omitted, it is the folder of the calling Desk chat.',
    inputSchema: S({
      cwd: {
        type: 'string',
        description:
          'Any folder inside the project (the checkout is found from it). Omit it inside a Desk chat.',
      },
    }),
    run: async (a: Record<string, unknown>) => {
      const { cwd } = await folderOf(a)
      return api(`/api/dashboards/workspace?cwd=${encodeURIComponent(cwd)}`)
    },
  },
  {
    name: 'dashboard_write',
    description:
      "MUTATES: the small dashboard the person sees for this project in AgentHydra. Put what is worth a glance there: status, numbers, open items, links, a short note. Keep it current by rewriting widgets by id (the same id replaces that widget) rather than adding new ones. `put` takes widgets: each needs id, kind and title, plus that kind's field: stat -> value (with unit, delta, tone, caption); list -> items (also for links); note -> text (markdown); progress -> current and max; chart -> series (and labels). `remove` takes widget ids; `clear: true` removes all widgets first. `cwd` is any folder inside the project; omitted, it is the calling Desk chat's folder. `by` names who writes (up to 60 characters); omitted, it is the calling chat's title.",
    inputSchema: S({
      cwd: {
        type: 'string',
        description:
          'Any folder inside the project (the checkout is found from it). Omit it inside a Desk chat.',
      },
      put: { type: 'array', items: WIDGET_ITEM, description: 'Widgets to add or replace, by id.' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Widget ids to delete.' },
      clear: { type: 'boolean', description: 'true removes every widget first.' },
      by: { type: 'string', description: 'Who writes, up to 60 characters.' },
    }),
    run: async (a: Record<string, unknown>) => {
      const { cwd, chat } = await folderOf(a)
      const given = str(a.by).trim()
      if (given.length > 60) throw new Error('by is over 60 characters')
      const by = given || chat?.title?.slice(0, 60) || 'an agent'
      return api('/api/dashboards/workspace', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          cwd,
          put: a.put,
          remove: a.remove,
          clear: a.clear,
          by,
        }),
      })
    },
  },
]

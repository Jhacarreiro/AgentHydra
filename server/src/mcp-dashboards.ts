// server/src/mcp-dashboards.ts - dashboard_read and dashboard_write: the small dashboard a person sees for a project in
// AgentHydra. Both call the daemon's /api/dashboards routes; the folder defaults to the calling Desk chat's, as desk_chat's does.
import { api, type HydraTool, JSON_HEADERS, S, str } from './mcp-client'
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

const CWD = {
  type: 'string',
  description:
    'Any folder inside the project (the checkout is found from it). Omit it inside a Desk chat.',
}

export const DASHBOARD_TOOLS: HydraTool[] = [
  {
    name: 'dashboard_read',
    callerChat: 'deskChat',
    listed: true,
    description:
      "READ-ONLY: the project's dashboard, a small website the person opens in AgentHydra. Answers `url` (open it with a browser tool to see it), `folder` (a local AI may also edit files there directly), and `entries` (path, bytes, updatedAt). `path` also returns that file's content. With nothing written yet, `files` is 0: start with dashboard_write and an index.html. `cwd` is any folder inside the project; omitted, it is the calling Desk chat's folder.",
    inputSchema: S({
      cwd: CWD,
      path: {
        type: 'string',
        description: 'A file in the site (e.g. index.html) to return the content of.',
      },
    }),
    run: async (a: Record<string, unknown>) => {
      const { cwd } = await folderOf(a)
      const path = str(a.path).trim()
      return api(
        `/api/dashboards/workspace?cwd=${encodeURIComponent(cwd)}${path ? `&path=${encodeURIComponent(path)}` : ''}`,
      )
    },
  },
  {
    name: 'dashboard_write',
    callerChat: 'deskChat',
    listed: true,
    description:
      "MUTATES: the project's dashboard is its own small website the person opens in AgentHydra, and you have full control: write anything (HTML, CSS, JS, charts, images, a data.json your page fetches, or a whole built dist via `from`). index.html is the entry. Applied in order, all-or-nothing: `clear`, `from` (absolute folder to publish), `files` [{path, content, encoding?: utf8|base64}], `edits` [{path, old, new}] (old must occur exactly once; prefer edits to change part of a page another chat also writes), `remove` [paths]. Paths are relative with forward slashes (letters, digits . _ -), up to 8 deep; files up to 5 MB, site up to 50 MB and 1000 files. The answer gives `url` (open it with a browser tool to look at your work) and `folder` (a local AI may also write files there directly). `cwd` is any folder inside the project; omitted, it is the calling Desk chat's folder. `by` names who writes (up to 60 characters); omitted, it is the calling chat's title.",
    inputSchema: S({
      cwd: CWD,
      by: { type: 'string', description: 'Who writes, up to 60 characters.' },
      clear: { type: 'boolean', description: 'true empties the site first.' },
      from: {
        type: 'string',
        description: 'Absolute folder whose contents replace the whole site (a built dist).',
      },
      files: {
        type: 'array',
        description: 'Files to create or overwrite.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            encoding: { type: 'string', enum: ['utf8', 'base64'] },
          },
          required: ['path', 'content'],
        },
      },
      edits: {
        type: 'array',
        description: 'Exact text replacements; old must occur exactly once in the file.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old: { type: 'string' },
            new: { type: 'string' },
          },
          required: ['path', 'old', 'new'],
        },
      },
      remove: { type: 'array', items: { type: 'string' }, description: 'File paths to delete.' },
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
          by,
          clear: a.clear,
          from: a.from,
          files: a.files,
          edits: a.edits,
          remove: a.remove,
        }),
      })
    },
  },
]

import { statsOf } from './hydra-core/log'
import { coreDir } from './hydra-core/paths'
import { answer, findTool, report, scope } from './hydra-core/tree'
import { defaultDaemon, use } from './hydra-core/use'
import { api, type HydraTool, S, str } from './mcp-client'

function chatOf(a: Record<string, unknown>): string {
  const chat = str(a.chat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim() || ''
  if (!chat) throw new Error('no chat: pass chat, or run inside a Desk chat (HYDRA_DESK_CHAT_ID)')
  return chat
}

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : undefined

const MODES = ['become', 'consult', 'hire', 'load']
const OUTCOMES = ['done', 'partial', 'failed']

export const CORE_TOOLS: HydraTool[] = [
  {
    name: 'core_scope',
    listed: true,
    description:
      'MUTATES: start a scope run for this chat. Returns the first question (q1) and the folder knowledge.',
    inputSchema: S({ chat: { type: 'string' } }),
    run: async (a: Record<string, unknown>) => scope(coreDir(), chatOf(a)),
  },
  {
    name: 'core_answer',
    listed: true,
    description:
      'MUTATES: answer the current scope question. Pass the answer text and picks (numbers or ids). Returns the next question or the verdict.',
    inputSchema: S(
      {
        chat: { type: 'string' },
        answer: { type: 'string' },
        picks: { type: 'array', items: { type: 'string' } },
      },
      ['answer'],
    ),
    run: async (a: Record<string, unknown>) =>
      answer(coreDir(), chatOf(a), { answer: str(a.answer), picks: stringList(a.picks) }),
  },
  {
    name: 'core_find',
    listed: true,
    description:
      'Find catalog entries (people, tools, workers, knowledge, skills) for a need. Five per page; more=true for the next page.',
    inputSchema: S(
      {
        need: { type: 'string' },
        kind: { type: 'string', enum: ['person', 'instrument', 'worker', 'knowledge', 'skill'] },
        more: { type: 'boolean' },
        chat: { type: 'string' },
      },
      ['need'],
    ),
    run: async (a: Record<string, unknown>) =>
      findTool(coreDir(), {
        need: str(a.need),
        kind: str(a.kind).trim() || undefined,
        more: a.more === true,
        chat: str(a.chat).trim() || undefined,
      }),
  },
  {
    name: 'core_use',
    listed: true,
    description:
      'MUTATES: use a catalog entry: become (take the lead), consult (ask it a question through a worker), hire (add it under you), or load (read its text).',
    inputSchema: S(
      {
        chat: { type: 'string' },
        id: { type: 'string' },
        mode: { type: 'string', enum: MODES },
        question: { type: 'string' },
        job: { type: 'string' },
      },
      ['id', 'mode'],
    ),
    run: async (a: Record<string, unknown>) =>
      use(
        coreDir(),
        {
          chat: chatOf(a),
          id: str(a.id).trim(),
          mode: str(a.mode) as 'become' | 'consult' | 'hire' | 'load',
          question: str(a.question).trim() || undefined,
          job: str(a.job).trim() || undefined,
        },
        defaultDaemon(api),
      ),
  },
  {
    name: 'core_report',
    listed: true,
    description:
      'MUTATES: report how the run went (done, partial or failed), with a note and any entries that were overruled.',
    inputSchema: S(
      {
        chat: { type: 'string' },
        outcome: { type: 'string', enum: OUTCOMES },
        note: { type: 'string' },
        overruled: { type: 'array', items: { type: 'string' } },
      },
      ['outcome', 'note'],
    ),
    run: async (a: Record<string, unknown>) =>
      report(coreDir(), {
        chat: chatOf(a),
        outcome: str(a.outcome),
        note: str(a.note),
        overruled: stringList(a.overruled),
      }),
  },
  {
    name: 'core_stats',
    listed: false,
    description: 'Hydra Core log stats: misses per entry, overruled counts, report count.',
    inputSchema: S({}),
    run: async () => statsOf(coreDir()),
  },
]

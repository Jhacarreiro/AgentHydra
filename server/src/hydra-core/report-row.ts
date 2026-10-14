import { existsSync, readFileSync } from 'node:fs'
import { appendLog } from './log'
import { chatPaths } from './paths'

export interface ReportArgs {
  chat: string
  outcome: string
  note: string
  overruled?: string[]
  score?: number
  missing?: string
}

function runOf(dir: string, chat: string): number | null {
  const file = chatPaths(dir, chat).state
  if (!existsSync(file)) return null
  try {
    const run = (JSON.parse(readFileSync(file, 'utf8')) as { run?: unknown }).run
    return typeof run === 'number' ? run : null
  } catch {
    return null
  }
}

export function reportRun(dir: string, args: ReportArgs, now = new Date()) {
  if (
    args.score !== undefined &&
    (!Number.isInteger(args.score) || args.score < 1 || args.score > 5)
  )
    throw new Error('score is a whole number from 1 to 5')
  const run = runOf(dir, args.chat)
  const missing = args.missing?.trim() || undefined
  appendLog(
    dir,
    {
      chat: args.chat,
      run,
      event: 'report',
      outcome: args.outcome,
      note: args.note,
      overruled: args.overruled ?? [],
      ...(args.score === undefined ? {} : { score: args.score }),
      ...(missing ? { missing } : {}),
    },
    now,
  )
  return { ok: true, run }
}

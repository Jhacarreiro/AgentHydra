// The claude backend (core/README.md): one turn of a task through the Agent SDK on one Claude account. The SDK entry,
// the message-to-item mapping and the usage-limit reading are Desk 2's, imported here, never copied.
import type {
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { claudeCodeBinaryFor } from '../../../desk2/server/src/engine/claude-code-binary'
import { createNormalizer } from '../../../desk2/server/src/engine/normalize'
import { resetsAtMs } from '../../../desk2/server/src/engine/status'
import { isUsageLimitText } from '../../../desk2/server/src/engine/usage-limit'
import { sdkQuery } from '../../../desk2/server/src/host/sdk'
import type { Account, Backend, Task, TurnEnd, TurnSink } from '../types'

/** A usage limit that names no reset holds the account this long: the five-hour window. */
const LIMIT_HOLD_MS = 5 * 60 * 60 * 1000

/** Each chat's turns in flight, so release() can abort them. */
const running = new Map<string, Set<AbortController>>()

type Normalizer = ReturnType<typeof createNormalizer>

/** What one turn learns from its messages as they arrive. */
interface TurnState {
  threadId: string | null
  resetAt: number | null
}

export function claudeBackend(): Backend {
  return {
    service: 'claude',
    start(task, account, sink) {
      const abort = new AbortController()
      let stopped = false
      const turns = running.get(task.chatId) ?? new Set<AbortController>()
      running.set(task.chatId, turns)
      turns.add(abort)
      const done = run(task, account, sink, abort, () => stopped).finally(() => {
        turns.delete(abort)
        if (running.get(task.chatId) === turns && !turns.size) running.delete(task.chatId)
      })
      return {
        done,
        interrupt() {
          stopped = true
          abort.abort()
        },
      }
    },
    async release(chatId) {
      for (const abort of running.get(chatId) ?? []) abort.abort()
      running.delete(chatId)
    },
  }
}

/** The task's message: its text, then its pictures as image blocks. */
function userMessage(task: Task): SDKUserMessage {
  const content = [
    { type: 'text', text: task.text },
    ...(task.images ?? []).map((i) => ({
      type: 'image',
      source: { type: 'base64', media_type: i.mediaType, data: i.dataBase64 },
    })),
  ] as SDKUserMessage['message']['content']
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: task.thread?.threadId ?? '',
  }
}

/** The SDK options for one turn: the account's config home, the task's model, effort and thread, and the binary. */
function queryOptions(task: Task, account: Account, abort: AbortController): Options {
  const binary = claudeCodeBinaryFor(account.home).path()
  return {
    env: { ...process.env, CLAUDE_CONFIG_DIR: account.home },
    cwd: task.cwd,
    persistSession: true,
    abortController: abort,
    permissionMode: task.permissionMode as PermissionMode,
    ...(task.model ? { model: task.model } : {}),
    ...(task.effort ? { effort: task.effort as Options['effort'] } : {}),
    ...(task.thread ? { resume: task.thread.threadId } : {}),
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
  }
}

/** Reports a thread id the first time the SDK names one that differs from the turn's. */
function observeThread(msg: SDKMessage, turn: TurnState, account: Account, sink: TurnSink): void {
  const sid = (msg as { session_id?: string }).session_id
  if (!sid || sid === turn.threadId) return
  turn.threadId = sid
  sink.thread({ accountId: account.id, label: account.label, threadId: sid })
}

/** Forwards the message's items to the sink, with the activity line a thinking block or a running tool shows. */
function forwardItems(normalizer: Normalizer, msg: SDKMessage, sink: TurnSink): void {
  for (const e of normalizer.handle(msg)) {
    if (e.type !== 'upsert' || e.item.kind === 'user' || e.item.kind === 'result') continue
    sink.item(e.item)
    if (e.item.kind === 'thinking') sink.activity('Thinking')
    else if (e.item.kind === 'tool_use' && e.item.status === 'running')
      sink.activity(`Running ${e.item.name}`)
  }
}

/** Keeps the reset time of a rate limit the SDK has rejected. */
function noteRateLimit(msg: SDKMessage, turn: TurnState): void {
  if (msg.type !== 'rate_limit_event') return
  const info = (msg as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info
  if (info?.status === 'rejected') turn.resetAt = resetsAtMs(info.resetsAt)
}

/** The end of a turn whose SDK result arrived: a success, an interrupt, or the error the SDK reported. */
function resultEnd(
  msg: SDKMessage,
  stopped: () => boolean,
  resetAt: number | null,
): Omit<TurnEnd, 'durationMs'> {
  const r = msg as { subtype: string; is_error?: boolean; errors?: string[]; result?: string }
  if (r.subtype === 'success' && !r.is_error) return { ok: true }
  if (stopped()) return { ok: false, error: 'Interrupted' }
  const error = (r.errors?.length ? r.errors.join('\n') : r.result) || r.subtype
  // A usage limit holds the account until its reset, so the message can go on another one.
  if (isUsageLimitText(error))
    return { ok: false, error, limitedUntil: resetAt ?? Date.now() + LIMIT_HOLD_MS }
  return { ok: false, error }
}

async function run(
  task: Task,
  account: Account,
  sink: TurnSink,
  abort: AbortController,
  stopped: () => boolean,
): Promise<TurnEnd> {
  const started = Date.now()
  const finish = (end: Omit<TurnEnd, 'durationMs'>): TurnEnd => ({
    ...end,
    durationMs: Date.now() - started,
  })
  const normalizer = createNormalizer({
    cwd: task.cwd,
    title: () => task.title,
    accountLabel: () => account.label,
  })
  const options = queryOptions(task, account, abort)
  const prompt = (async function* () {
    yield userMessage(task)
  })()
  const turn: TurnState = { threadId: task.thread?.threadId ?? null, resetAt: null }
  try {
    for await (const msg of sdkQuery({ prompt, options }) as AsyncIterable<SDKMessage>) {
      observeThread(msg, turn, account, sink)
      forwardItems(normalizer, msg, sink)
      noteRateLimit(msg, turn)
      if (msg.type === 'result') return finish(resultEnd(msg, stopped, turn.resetAt))
    }
    if (stopped()) return finish({ ok: false, error: 'Interrupted' })
    return finish({ ok: false, error: 'The turn ended without a result' })
  } catch (err) {
    if (stopped()) return finish({ ok: false, error: 'Interrupted' })
    return finish({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

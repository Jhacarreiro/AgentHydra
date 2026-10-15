// The module-level types and plain constants of ChatManager (chat-manager.ts), moved out for its size.
// Types and values only: this module imports nothing at run time.
import type { Query, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { AccountRef, ChatServiceKind, ChatSummary, DeskSettings, ImageRef, ServerEvent, TranscriptItem } from '@shared/protocol'
import type { Bridge } from '../bridge'
import type { ChatRuntime, QueryImpl } from './chat-runtime'
import type { CodexDirectory } from './codex/accounts'
import type { OpenAppServer } from './codex/app-server'
import type { FreeChats } from './chatgpt/runtime'
import type { RetryDelays, RetryItem } from './send-retry'
import type { ServiceRuntime } from './service-runtime'
import type { TitleGenerator } from './chat-title'

export type ManagerBridge = Pick<Bridge, 'completionFinished' | 'startWorker' |'sendToWorker' | 'takesRequestIds' | 'canDeliverNow' | 'sendToWorkerNow' | 'cancelWorkerHeld' | 'cancelWorker' | 'workersByIds' | 'workerItems' | 'workerFileOf' | 'listAccounts' | 'externalSessions' | 'externalSession' | 'externalHistory' | 'sessionRoots' | 'lastWorkers' | 'setExtraWorkerIds' | 'setExcludeSessionIds' | 'setSessionMeta'>

export interface ChatManagerOptions {
  home: string
  /** The home folder whose .claude a chat with no account folder is seeded into (default: the user's own). Tests pass a temp folder so they never write into the real Claude config. */
  claudeHome?: string
  /** A move to another account starts a fresh session from a condensed handoff above this many tokens of
   *  session (SPEC "Account failover"). Default HYDRA_DESK_HANDOFF_TOKENS, else HANDOFF_TOKENS. */
  handoffTokens?: number
  /** A message to an idle chat whose session has grown past this many tokens starts a fresh session from a condensed
   *  handoff on the same account. Default HYDRA_DESK_FRESH_TOKENS, else FRESH_TOKENS. */
  freshTokens?: number
  /** Hydra Desk's own address, which a handoff names for the full transcript and each chat's move line. */
  deskUrl?: () => string
  emit(event: ServerEvent): void
  settings: () => DeskSettings
  bridge: ManagerBridge
  /** Called with a chat's session ids when the chat is deleted or archived; must not throw. */
  onChatEnd?: (sessions: string[]) => void
  /** Default: chats run in chat hosts (SPEC "Chat hosts"), or in this process with HYDRA_DESK_HOSTS=0. */
  queryImpl?: QueryImpl
  env?: Record<string, string | undefined>
  /** undefined = each runtime reads ~/.claude.json; null = none. */
  agentHydraMcp?: McpServerConfig | null
  /** See ChatRuntimeDeps.mainClaudeJson. */
  mainClaudeJson?: string | null
  now?: () => number
  storeDebounceMs?: number
  /** How long supportedCommands() / supportedModels() may take before the static list answers. */
  liveListTimeoutMs?: number
  /** What a new chat is: a CliMayte worker (the default, and the only one the app uses), or 'sdk', a
   *  ChatRuntime on the default login, which the runtime's own tests start chats with. */
  newChats?: 'climayte' | 'sdk'
  /** Names a new chat from its first message; null = never. Default: a Sonnet query (none when queryImpl is faked). */
  titleGenerator?: TitleGenerator | null
  /** How long a CliMayte chat's message AgentHydra did not take waits before it is sent again (send-retry.ts). */
  retryDelays?: RetryDelays
  /** AgentHydra's Codex accounts, for chats pinned to Codex (Pin service); absent, Codex is not offered. */
  codex?: CodexDirectory
  /** Default: one shared app-server per Codex home (codex/app-server.ts); tests give a fake. */
  openCodex?: OpenAppServer
  /** Desk's Free instances, for chats pinned to ChatGPT (read at each use: the Free plugin starts after this one); absent, ChatGPT is not offered. */
  free?: () => FreeChats | undefined
}

/** What answers a chat's open requests: its Claude runtime, or its Codex one. */
export type RequestAnswerer = Pick<ChatRuntime, 'respondPermission' | 'answerQuestion' | 'respondPlan' | 'answerElicitation'>

/** The names Pin service gives each service, in the chat's lines and in a handoff. */
export const SERVICE_LABEL: Record<ChatServiceKind, string> = { claude: 'Claude', codex: 'Codex', chatgpt: 'ChatGPT' }

/** What the send queue's dispatch asks of a send (SPEC "Send queue"). */
export interface SendOptions {
  /** Refuse with 409 while a turn runs or is about to, instead of joining the CLI's own queue (which nothing can edit or recall). */
  onlyIfReady?: boolean
  /** The SDK message uuid, which is also the user item's id: a send the queue made is found in the transcript by it. */
  messageId?: string
  /**
   * A person's plain send (Enter in "Send immediately", or Send now on a queue row): to a running CliMayte worker it
   * goes now, as Send now on its bubble does, not after the worker's whole task. An SDK chat's CLI takes it into the
   * running turn anyway.
   */
  now?: boolean
  /** An automatic note (AgentHydra's CliMayte ping), not the owner's words: it never names a chat that has no title yet. */
  noTitle?: boolean
}

/** createFromQueue's answer: the chat and how its first message went (its error, or null). `waiting` is
 *  never answered now that CliMayte queues a worker until an account has room; the queue still reads it. */
export type QueueCreated = { waiting: 'no-room' | 'unreachable' } | { chat: ChatSummary; firstSend: Promise<string | null> }

/** How many accounts a generated title is asked of: the first, and one retry. */
export const TITLE_TRIES = 2
/** A chat with a turn under way (the send queue waits on these). */
export const LIVE = new Set<ChatSummary['status']>(['starting', 'working', 'needs_you'])
export const IMPORT_TITLE = 'Claude Code session'
/** Outside sessions that cannot be continued here, as their refusal names them. */
export const READ_ONLY_SOURCES: Record<'climayte' | 'other', string> = { climayte: 'CliMayte worker', other: 'outside' }
/** The CliMayte group Hydra Desk's chats run in. */
export const WORKER_GROUP = 'hydra-desk'
/** What a worker chat shows as its model: AgentHydra's chat mode launches it on Opus (xhigh), and Desk forces nothing. */
export const WORKER_MODEL = 'opus'
/** The account a chat shows before CliMayte has placed its worker. */
export const CLIMAYTE_ACCOUNT: AccountRef = { id: 'climayte', label: 'CliMayte', configDir: null }

/** The items JSON kept across chats (characters, about bytes): the least recently answered goes first. */
export const ITEMS_BODY_BYTES = 64 * 1024 * 1024

export interface Entry {
  chat: ChatSummary
  runtime: ChatRuntime | null
  /** The runtime of the service the chat is pinned to (Pin service), once it has run there; kept while it winds down after the pin moved on. */
  pinned?: ServiceRuntime | null
  /** Messages sent after the pin moved while the old service was still replying: they wait, shown queued, and go to the new one once that reply ends. */
  crossing?: { item: UserItem; text: string; images?: ImageRef[]; opts: SendOptions }[]
  /** The query the runtime runs now (for supportedCommands / supportedModels). */
  query: Query | null
  /** Set while the chat's worker is being started: a second send waits for it instead of starting another. */
  starting?: Promise<void>
  /** A CliMayte chat: a short hash of what each item of its Desk file looked like when last written or emitted (the file is the record, the worker's session JSONL the live source). Dropped once its worker is finished; the Desk file seeds it again. */
  emitted?: Map<string, string>
  /** What matchWorkers last matched the chat on (the worker list and the chat's own ids): the same input is not matched again. */
  matchKey?: string
  /** The chat was live at its last check: when it leaves live, the chats waiting on it are told once (turnEnded). */
  turnLive?: boolean
  /** A CliMayte chat: the worker's session file and the account it was found under, so a poll does not search the session folders again. */
  cwdFile?: { sessionId: string; account: string | null; file: string }
  /** A CliMayte chat with a turn in flight: its session file is watched, so a write is read at once (the poll stays the fallback). */
  turnWatch?: { file: string; timer?: ReturnType<typeof setTimeout>; stop: () => void }
  /** The worker's items as the last poll went through them: the bridge answers the same array while nothing changed. */
  workerSeen?: TranscriptItem[]
  /** The account the worker's JSONL was last read under: a change means the live file may have moved, so it is looked for again. */
  readAccount?: string | null
  /** False once its worker was seen finished: the poll stops reading it until the next send. */
  workerLive?: boolean
  /** A fork not started yet: the uuid of the source session's last entry when it was forked (its cut). */
  forkAt?: string
  /** The config folder the chat's last process ran under (null = the default login), kept across restarts:
   *  its copy of the session has the latest turns. Undefined: Hydra Desk never ran it. */
  ranIn?: string | null
  /** The sessions this chat ran before a move started a fresh one (oldest first, Hydra Desk's handoff): still its own, never "Elsewhere". */
  pastSessions?: string[]
  /** The accounts the message in flight has failed on or moved through (carryToAnotherAccount); cleared by the next send. */
  moved?: string[]
  /** Set while carryToAnotherAccount moves the chat: a send waits for it (then it goes to the new account, after the replay). */
  moving?: Promise<void>
  /** The session copy under way (seedResume): a second start waits for it instead of copying onto the same file. */
  seeding?: Promise<string | null>
  /** The owner named this chat (or it was named once already): the generated title never replaces it. */
  titled?: boolean
  /** The ids of its own background tasks still running that count toward backgroundActive (long-lived ones do not). */
  bgTasks?: Set<string>
  /** A CliMayte chat: the task items Hydra Desk settled because their session ended (endTasks). The worker's own
   *  JSONL still says 'running' for them, which never replaces the settled item; a real notice still does. */
  ended?: Set<string>
  /** A folder the session ended its last turn in, outside the chat's own (cwd-move): the move happens only if the next turn begins and ends there. `offset` is the transcript's size at that turn end. */
  cwdPending?: { target: string; file: string; offset: number }
  /** The owner's latest message (cwd-move: a move it asked for needs no second turn). */
  lastAsk?: string
  /** The folder the chat's worker was last started or sent into; a different chat.cwd is a move to pass on. */
  workerCwd?: string
  /** A CliMayte chat: the messages sent that its worker's JSONL does not show yet, shown meanwhile; kept with the chat record, never in the Desk's items file. */
  sent?: UserItem[]
  /** A CliMayte chat: when its worker first read done while its JSONL did not show what was sent yet (applyWorker). */
  endHeldSince?: number
  /** A CliMayte chat: the messages AgentHydra has not taken yet (it did not answer), oldest first, each sent again
   *  with its own request id until it is (retryHeld); a later message waits behind them. Kept with the chat record. */
  retrying?: RetryItem[]
  /** The one loop sending `retrying`, while it runs. */
  retryLoop?: Promise<void>
  /** The held message that loop is sending right now: Cancel waits for its answer. */
  retrySending?: RetryItem
  /** The ledger id of the chat's latest failure: a move to another account marks it recovered. */
  lastFailure?: string
  /** A CliMayte chat: the worker error already in the ledger, so a re-read of the same failure adds no row. */
  workerErrorSeen?: string | null
}

export type UserItem = Extract<TranscriptItem, { kind: 'user' }>

/** How many accounts one message is tried on (the first and the ones it moves to). */
export const MAX_MOVES = 4

/** How long placement skips an account whose sign-in failed (CliMayte's identity wall retries every 6 hours). */
export const SIGN_IN_HOLD_MS = 6 * 60 * 60 * 1000
/** How long a worker that read done stays busy while its JSONL does not show what was sent yet (applyWorker). */
export const WORKER_END_GRACE_MS = 15_000
/** How long a write to a turn's file waits before its worker is read (a burst of writes is read once). */
export const TURN_WATCH_MS = 100

/** The account a chat gets (resolveAccount). */
export interface ResolvedAccount {
  account: AccountRef
  auto: boolean
  note: string | null
}

/** The stored chat record: a fork's cut and the folder the chat last ran in ride along, kept out of ChatSummary and so off the wire. */
export type StoredRecord = ChatSummary & { forkAt?: unknown; ranIn?: unknown; pastSessions?: unknown; workerCwd?: unknown; sent?: unknown; retrying?: unknown }

/** The held message's retry pace: the wait before the next try, and AgentHydra's own errors so far. */
export interface RetryPace {
  wait: number
  serverErrors: number
  firstMs: number
  maxMs: number
}

/** Where a fork at one of the owner's messages resumes (findCut). */
export interface Cut {
  sessionId: string
  /** The entry before the message; null when it opened the session (the fork starts fresh). */
  cut: string | null
  /** The config folder of the file it was found in (null = the default ~/.claude): the fork's first start copies the session from there. */
  configDir: string | null
}

export const CUT_NOT_FOUND = 'Could not find this message in its session file, so there is no telling where the fork would start.'
export const UNDO_NOT_FOUND = 'Could not find this message in its session file, so there is no telling where the chat would go back to.'

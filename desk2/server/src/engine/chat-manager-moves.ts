// ChatManager's moves and handoffs (chat-manager.ts), moved out for its size: a turn that ends in another folder,
// a limit or sign-in that moves the chat to another account, and the fresh session a big or unresumable one starts.
// It reaches the manager only through MovesHost.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AccountInfo, ChatSummary, ServerEvent } from '@shared/protocol'
import { findSessionJsonl, firstCwdFrom, lastCwd } from '../bridge/session-jsonl'
import { askedToMove, movedOutOf } from './cwd-move'
import type { ChatRuntime } from './chat-runtime'
import type { QueuedInput } from './input-queue'
import { buildHandoff, CONTINUE_TEXT, GROWN } from './handoff'
import type { ChatStore } from './store'
import type { FailureInput, FailureLedger } from './failures'
import { MAX_MOVES, type Entry, type ManagerBridge, SIGN_IN_HOLD_MS } from './chat-manager-types'
import { accountName, accountRef, pickHealthy } from './chat-manager-helpers'

/** What the moves read and call on ChatManager: its fields, and the members of the manager a move applies to. */
export interface MovesHost {
  readonly chats: Map<string, Entry>
  readonly bridge: ManagerBridge
  readonly store: ChatStore
  readonly failures: FailureLedger
  readonly emitEvent: (event: ServerEvent) => void
  readonly signInHeld: Map<string, number>
  deskUrl(): string
  root(configDir: string | null): string
  placeable(accounts: AccountInfo[]): AccountInfo[]
  bigSession(e: Entry): { sessionId: string; tokens: number } | null
  seedResume(e: Entry): Promise<string | null> | null
  changed(chat: ChatSummary): void
  systemLine(chatId: string, kind: string, level: 'info' | 'warn', text: string): void
  fail(e: Entry, f: Pick<FailureInput, 'message' | 'fallback' | 'cause' | 'durationMs'>): void
}

export class ChatMoves {
  constructor(private readonly host: MovesHost) {}

  /**
   * An SDK chat's turn ended: if its session's own transcript says the process is now in another folder
   * (the model cd'd out), the chat moves there. The process runs in the old folder, so it ends at once (the
   * chat is idle) and the next send starts in the new one, resuming the same session (seedResume puts the
   * transcript under the new folder).
   */
  checkMoved(chatId: string): void {
    const e = this.host.chats.get(chatId)
    if (!e?.chat.sessionId || e.chat.workerId !== undefined) return
    const root = this.host.root((e.runtime?.startedAs ?? e.chat.account).configDir)
    if (this.noteCwd(e, findSessionJsonl(e.chat.sessionId, [root, ...this.host.bridge.sessionRoots()], e.chat.cwd))) void e.runtime?.closeWhenIdle()
  }

  /**
   * A turn ended: moves the chat to the folder `file` (its session's transcript) says it ended in, when that
   * is a folder a chat can live in outside its own (movedOutOf) AND either the owner's message asked for that
   * move or the previous turn also ended there and this one began there (its first line's cwd). Otherwise the
   * folder is only remembered as pending. Moving: stored cwd, one muted line, the sidebar update.
   */
  noteCwd(e: Entry, file: string | null): boolean {
    const pending = e.cwdPending
    const ask = e.lastAsk
    e.cwdPending = undefined
    e.lastAsk = undefined
    if (!file) return false
    let observed: string | null
    let size: number
    try {
      observed = lastCwd(file)
      size = statSync(file).size
    } catch {
      return false
    }
    const target = movedOutOf(e.chat.cwd, observed)
    if (!target) return false
    let held = false
    if (pending && pending.file === file && pending.target.toLowerCase() === target.toLowerCase()) {
      try {
        const began = firstCwdFrom(file, pending.offset)
        held = began !== null && resolve(began).toLowerCase() === target.toLowerCase()
      } catch {
        held = false
      }
    }
    if (!held && !askedToMove(ask, target)) {
      e.cwdPending = { target, file, offset: size }
      return false
    }
    e.chat.cwd = target
    this.host.systemLine(e.chat.id, 'cwd', 'info', `Moved this chat to ${target}.`)
    this.host.changed(e.chat)
    return true
  }

  /**
   * An SDK chat's turn failed on its account (login dead or usage limit): the session is copied into
   * another healthy account's folder and the unanswered messages are sent again there, once, with a muted
   * line saying so. At most MAX_MOVES accounts per message; then the runtime's own error stays. Answers
   * synchronously whether a move was taken on (the runtime then does not notify a stop); the move itself
   * runs after. Accounts and their health are AgentHydra's word (listAccounts), never a token or credential.
   */
  carryToAnotherAccount(chatId: string, signIn: boolean, window: string | null): boolean {
    const e = this.host.chats.get(chatId)
    const rt = e?.runtime
    // Auto off: the chat waits for its own account's reset (the runtime's limit stands).
    if (!e || !rt || e.chat.workerId !== undefined || e.chat.accountPinned) return false
    const tried = (e.moved ??= [e.chat.account.id])
    if (!tried.includes(e.chat.account.id)) tried.push(e.chat.account.id)
    if (signIn) this.host.signInHeld.set(e.chat.account.id, Date.now() + SIGN_IN_HOLD_MS)
    if (tried.length > MAX_MOVES) return false
    let done!: () => void
    e.moving = new Promise<void>((r) => (done = r))
    void this.moveChat(e, rt, signIn, window)
      .catch((err) => this.moveFailed(e, rt, `Could not move this chat to another account: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        e.moving = undefined
        done()
      })
    return true
  }

  private async moveChat(e: Entry, rt: ChatRuntime, signIn: boolean, window: string | null): Promise<void> {
    const chat = e.chat
    const tried = e.moved ?? []
    const from = chat.account
    const accounts = await this.host.bridge.listAccounts().catch(() => [])
    const next = pickHealthy(this.host.placeable(accounts), tried)
    if (!next) {
      this.moveFailed(e, rt, `${accountName(from)} ${signIn ? 'is signed out' : 'hit its limit'} and no other signed-in account has room (tried ${tried.map((id) => accountName(accounts.find((a) => a.id === id) ?? from)).join(', ')}).`)
      return
    }
    const { cut, sends } = rt.carrySends()
    const big = this.host.bigSession(e)
    tried.push(next.id)
    chat.account = accountRef(next)
    chat.accountAuto = true
    // A big session is not copied: the chat starts a fresh one from the handoff, so there is nothing slow to wait for.
    const out: QueuedInput[] = big ? [this.handoffSend(e, big, signIn ? 'signed out' : window ? `${window} limit` : 'usage limit', sends)] : []
    // Said before the session copy, which can take a while on a long chat.
    this.host.systemLine(chat.id, 'moved', 'info', `Moved from ${accountName(from)} (${signIn ? 'signed out' : window ? `${window} limit` : 'limit reached'}) to ${accountName(chat.account)}.`)
    if (big) this.host.systemLine(chat.id, 'handoff', 'info', `The session had grown to about ${Math.round(big.tokens / 1000)}k tokens, so it continues as a fresh session from a condensed handoff instead of a copy. This chat keeps the whole record.`)
    this.host.changed(chat)
    if (!big) {
      const cannot = await this.host.seedResume(e)
      if (cannot) {
        this.moveFailed(e, rt, cannot)
        return
      }
      // A turn that had replied is told to go on, once; its message would only ask it to start over.
      out.push(...(cut ? [{ text: CONTINUE_TEXT }, ...sends] : sends))
    }
    if (e.lastFailure) this.host.failures.recovered(e.lastFailure, chat.account.id)
    await rt.close()
    if (this.host.chats.get(chat.id) !== e) return
    this.host.changed(chat)
    rt.replay(out)
  }

  /**
   * An idle chat whose session has grown past freshTokens (bigSession): its process (if any) is closed and the
   * message becomes the first of a fresh session, the condensed handoff of the chat's record with the message at its
   * end (handoffSend). The chat keeps its whole record and the old session joins pastSessions.
   */
  async freshFrom(e: Entry, grown: { sessionId: string; tokens: number }, send: QueuedInput): Promise<QueuedInput> {
    await e.runtime?.close()
    const out = this.handoffSend(e, grown, GROWN, [send])
    this.host.systemLine(e.chat.id, 'fresh', 'info', `The session had grown to about ${Math.round(grown.tokens / 1000)}k tokens, so this message starts a fresh session from a condensed handoff of the chat. This chat keeps the whole record.`)
    this.host.changed(e.chat)
    return out
  }

  /**
   * The chat leaves its big session for a fresh one (no resume): the old session joins pastSessions and the
   * first message is the condensed handoff built from the chat file, with the sends the old session had not
   * answered after it.
   */
  private handoffSend(e: Entry, left: { sessionId: string; tokens: number | null }, why: string, sends: QueuedInput[]): QueuedInput {
    const chat = e.chat
    const text = buildHandoff({
      chatId: chat.id,
      title: chat.title,
      cwd: chat.cwd,
      items: this.host.store.loadItems(chat.id),
      sessions: [left.sessionId, ...(e.pastSessions ?? []).slice().reverse()],
      tokens: left.tokens,
      why,
      deskUrl: this.host.deskUrl(),
    })
    e.pastSessions = [...(e.pastSessions ?? []), left.sessionId]
    chat.sessionId = null
    chat.forkedFrom = null
    e.forkAt = undefined
    const images = sends.flatMap((s) => s.images ?? [])
    const heading = left.tokens === null || why === GROWN ? "The owner's message to answer now" : "The owner's messages the old session had not answered yet"
    const pending = sends.length ? `\n\n## ${heading}\n${sends.map((s) => s.text).join('\n\n')}` : ''
    return images.length ? { text: text + pending, images } : { text: text + pending }
  }

  /**
   * The saved session cannot be reopened on this machine (seedResume's reason): the chat leaves it for a fresh
   * session, whose first message is a condensed handoff of its record with the owner's message in it. Without this
   * every later send is refused with the same 409 and the chat is stuck. One message, not the handoff and then the
   * owner's: a handoff alone says to carry on where the old session stopped, and the fresh session would do that
   * before it read what the owner just asked. Idea from stablyai/orca's ACP "reopen takeover" (MIT); written fresh
   * here. The old session joins pastSessions (handoffSend), the chat keeps its record. Null with no session to leave.
   */
  takeOver(e: Entry, why: string, send: QueuedInput): QueuedInput | null {
    const chat = e.chat
    const sessionId = chat.sessionId ?? chat.forkedFrom
    if (!sessionId) return null
    const handoff = this.handoffSend(e, { sessionId, tokens: null }, why, [send])
    this.host.systemLine(chat.id, 'takeover', 'warn', 'The saved session could not be reopened on this machine, so this chat continues in a fresh session from a condensed handoff of its record. The chat keeps its whole record.')
    this.host.changed(chat)
    return handoff
  }

  /** The move could not be made: the chat keeps the error state, said once and notified. */
  private moveFailed(e: Entry, rt: ChatRuntime, text: string): void {
    const chat = e.chat
    this.host.systemLine(chat.id, 'move-failed', 'warn', text)
    this.host.fail(e, { message: text, cause: 'move_failed' })
    rt.rearmLimit()
    chat.lastError = text
    this.host.emitEvent({ type: 'notify', chatId: chat.id, reason: 'error', title: chat.title, body: text })
    this.host.changed(chat)
  }
}

// server/src/claude-native-new.ts - start a new chat inside a RUNNING app, without its window.
//
// fan_out started each chat with the claude://code/new deeplink, then a UI actuator raised the
// app's window and clicked Send (2026-10-15: AgentHydra full-screened, minimized and clicked
// through the owner's Claude window). The deeplink also cannot pin a model, so a spawned chat ran
// on whatever model the app last used. The native start makes the app's own startSession call with
// the folder, the model, the effort and the first message, then reads the new chat back.
import { withAppClient } from './claude-native-send'
import { normalizeClaudeNativeProfile } from './claude-native-settings'
import { nativeProgram } from './core/claude-native/native-program'

export interface NativeNewSpec {
  /** Absolute folder the chat starts in. */
  cwd: string
  /** The chat's first message: the start's own message, so the first turn is this text. */
  prompt: string
  /** The model the chat is pinned to, for example claude-opus-5-5. */
  model: string
  /** One of the app's effort levels (low, medium, high, xhigh, max). */
  effort: string
  /** Start the chat on Bypass permissions (the owner's doctrine for every spawned chat). */
  bypass?: boolean
}

export interface NativeNewOutcome {
  /** The chat started on the model and effort asked for. */
  ok: boolean
  /** True when nothing reached the app (not configured, not running, no connection, bad spec):
   *  nothing was started. False once the start was sent: never start the chat another way. */
  unavailable: boolean
  reason?: string
  /** The desktop chat id (local_...). */
  desktopSessionId?: string
  /** The CLI session id: the id transcripts, receipts and every AgentHydra chat route use. */
  cliSessionId?: string
  /** The chat exists with a CLI session, whether or not it kept the model and effort. */
  started?: boolean
  modelPinned?: boolean
  effortPinned?: boolean
  isRunning?: boolean
  /** What the app kept, read back after the start. */
  model?: string | null
  effort?: string | null
  permissionMode?: string | null
  cwd?: string | null
}

export async function tryNativeNew(
  profileDir: string,
  spec: NativeNewSpec,
): Promise<NativeNewOutcome> {
  const profile = normalizeClaudeNativeProfile(profileDir)
  // The inspector's 60 s ceiling (withAppClient) covers startSession, which returns once the first
  // message is delivered, and the program's own wait of up to 25 s for the CLI session id.
  const connected = await withAppClient(profileDir, async ({ pid, evaluate }) => {
    let expression: string
    try {
      // Builds the expression only: a spec the program refuses is never sent.
      expression = nativeProgram({
        action: 'new',
        pid,
        profileDir: profile,
        cwd: spec.cwd,
        prompt: spec.prompt,
        model: spec.model,
        effort: spec.effort,
        ...(spec.bypass !== undefined ? { bypass: spec.bypass } : {}),
      })
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) }
    }
    try {
      return { result: await evaluate(expression) }
    } catch (error) {
      return { lost: error instanceof Error ? error.message : String(error) }
    }
  })
  if (!connected.ok) return { ok: false, unavailable: true, reason: connected.reason }
  const value = connected.value
  if ('refused' in value) return { ok: false, unavailable: true, reason: value.refused }
  // A lost reply after the start was sent: the chat may exist, so the caller never retries it.
  if ('lost' in value) return { ok: false, unavailable: false, reason: value.lost }
  const result = value.result
  return {
    ok: result?.ok === true && result.verified === true,
    unavailable: result?.dispatch === 'not-sent',
    ...(result?.ok === true && result.verified === true
      ? {}
      : { reason: String(result?.reason ?? 'the app did not confirm the new chat') }),
    desktopSessionId: result?.sessionId ?? undefined,
    cliSessionId: result?.cliSessionId ?? undefined,
    started: result?.started === true,
    modelPinned: result?.modelPinned === true,
    effortPinned: result?.effortPinned === true,
    isRunning: result?.isRunning === true,
    model: result?.model ?? null,
    effort: result?.effort ?? null,
    permissionMode: result?.permissionMode ?? null,
    cwd: result?.cwd ?? null,
  }
}

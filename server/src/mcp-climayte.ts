// The CliMayte half of the MCP tool table: the ping line a dispatch answers with, the calling
// chat's origin and trace for a dispatch, the ping extras and the seen stamp a status read leaves,
// and the status read itself. mcp.ts's TOOLS entries call these; nothing else reaches in.

import { RECENT_FINISHED } from './climayte-lib'
import { buildTrace, type CliMayteBy, parseBy, processLabel } from './climayte-trace'
import { api, JSON_HEADERS, qs, str } from './mcp-client'
import { type CallerChatOrigin, callerOrigin, callerPidFromArgs } from './mcp-self'

/** What a CliMayte dispatch answers about its pings (docs/CLIMAYTE.md "Pings to the dispatching
 *  chat"). `route`: the route's own answer (absent when this daemon predates pings). */
export function climaytePingLine(
  caller: { origin: CallerChatOrigin | null; why: string | null },
  route: unknown,
  group: string,
): string {
  const off = (why: string) =>
    `off: ${why}; run python ~/.claude/tools/climayte_wait.py --group ${group}`
  if (!caller.origin) return off(caller.why ?? 'the calling chat could not be identified')
  const r = route as { on?: boolean; why?: string; to?: string } | null | undefined
  if (!r || typeof r.on !== 'boolean') return off('this AgentHydra daemon does not send pings yet')
  if (!r.on) return off(r.why ?? 'pings are off')
  if (r.to) return `on: manager ${r.to} is sent a message when work settles`
  return `on: ${caller.origin.sessionId.slice(0, 8)} is messaged when work settles (${caller.origin.how})`
}

/** The label of the process that called this tool (its script, else its program), for a dispatch whose
 *  caller is no chat: the HTTP caller's pid, or this stdio server's parents. Null when it cannot be read. */
async function mcpProcessLabel(a: Record<string, unknown>): Promise<string | null> {
  const pid = await callerPidFromArgs(a)
  if (pid === null) return null
  if (pid === undefined) return processLabel(process.pid, false)
  if (pid === process.pid) return 'AgentHydra'
  return processLabel(pid, true)
}

/** The calling chat for a dispatch (its ping origin), unless the caller opted out with `notify: false`, and
 *  the `by` the route records as the trace. The route's own socket is this daemon, so it cannot see the
 *  caller: whenever the origin it is sent is null, the trace goes in `by` (the chat found here, else the
 *  process, else the label the caller declared). A malformed `by` is refused here, as the route would. */
export async function dispatchOrigin(
  a: Record<string, unknown>,
): Promise<{ origin: CallerChatOrigin | null; why: string | null; by: CliMayteBy | undefined }> {
  const declared = parseBy(a.by)
  if (declared.why) throw new Error(declared.why)
  const caller = await callerOrigin(a)
  const origin = a.notify === false ? null : caller.origin
  const why = a.notify === false ? 'notify: false' : caller.why
  if (origin && !declared.by) return { origin, why: null, by: undefined }
  const trace = await buildTrace({
    chatSessionId: caller.origin?.sessionId,
    by: declared.by,
    process: () => mcpProcessLabel(a),
  })
  return {
    origin,
    why: origin ? null : why,
    by: { label: trace.label ?? 'a chat', sessionId: trace.sessionId },
  }
}

/** climayte_status's ping extras: `ping: true` adopts the group's live workers without an origin
 *  for the caller; pings no channel delivered to the caller are shown (and marked read). Null when
 *  there is nothing to add. Never throws: a status read must not fail on its extras. */
export async function climayteStatusPings(
  a: Record<string, unknown>,
  group: string | undefined,
): Promise<Record<string, unknown> | null> {
  const extra: Record<string, unknown> = {}
  let caller: { origin: CallerChatOrigin | null; why: string | null } | null = null
  if (a.ping === true) {
    if (!group) extra.ping = 'off: ping: true needs a group'
    else {
      caller = await callerOrigin(a)
      try {
        const r = caller.origin
          ? ((await api('/api/corch/adopt', {
              method: 'POST',
              headers: JSON_HEADERS,
              body: JSON.stringify({ group, origin: caller.origin }),
            })) as { adopted?: number; ping?: unknown })
          : null
        if (r) extra.adopted = r.adopted ?? 0
        extra.ping = climaytePingLine(caller, r?.ping, group)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        extra.ping = climaytePingLine({ origin: null, why }, null, group)
      }
    }
  }
  try {
    const { unread } = (await api('/api/corch/pings')) as { unread?: string[] }
    if (Array.isArray(unread) && unread.length) {
      caller ??= await callerOrigin(a)
      const sid = caller.origin?.sessionId
      if (sid && unread.includes(sid))
        extra.unreadPings = await api('/api/corch/pings/read', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ sessionId: sid }),
        })
    }
  } catch {
    // a daemon without the pings route: nothing unread to show
  }
  return Object.keys(extra).length ? extra : null
}

/** The longest a scoped status read or a cancel holds its answer, past the answer itself, for markSeen. The trace
 *  starts with the call and keeps its own CALLER_ORIGIN_BUDGET_MS: a slower one stamps after the answer has gone.
 *  A 3 s budget for the trace itself missed on the first read after a daemon restart (2026-10-13, at 99% CPU). */
export const SEEN_WAIT_MS = 3_000

/** Wait for `p` at most `ms`; it goes on either way. */
export async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))])
  clearTimeout(timer)
}

/** Tell the daemon the calling chat has looked at `scope` as of `at` (a scoped climayte_status read, or its own
 *  climayte_cancel), so the pings queued about those workers before then are left out (climayte-ping.ts stale).
 *  Never throws: a read or a cancel must not fail on its stamp; without one the ping goes as before. */
export async function markSeen(
  trace: Promise<{ origin: CallerChatOrigin | null }>,
  scope: { ids?: string[]; group?: string },
  at: number,
): Promise<void> {
  try {
    const { origin } = await trace
    if (!origin || (!scope.group && !scope.ids?.length)) return
    await api('/api/corch/seen', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId: origin.sessionId, ...scope, at }),
    })
  } catch {
    // a daemon without the seen route, or a stamp that failed: the ping goes as it would have
  }
}

/** What a climayte_status call looked at, for markSeen: its ids, else its group. Nothing for an unscoped list
 *  or `active` (finished workers it did not show). */
export function statusScope(
  a: Record<string, unknown>,
  group: string | undefined,
): { ids?: string[]; group?: string } | null {
  if (a.active === true) return null
  const ids = [
    ...(a.id != null && str(a.id) ? [str(a.id)] : []),
    ...(Array.isArray(a.ids)
      ? a.ids.filter((x): x is string => typeof x === 'string' && x !== '')
      : []),
  ]
  if (ids.length) return { ids }
  return group ? { group } : null
}

/** climayte_status's own answer: one worker, a wave, or the list in scope. `waitCap`: the most it may
 *  watch, what the call has left of CLIMAYTE_MAX_WAIT_S. */
export async function climayteStatusRead(
  a: Record<string, unknown>,
  group: string | undefined,
  waitCap: number,
  seenBy?: string,
): Promise<unknown> {
  const wait = Math.min(waitCap, Math.max(0, Number(a.wait_seconds) || 0))
  const ids = Array.isArray(a.ids) ? a.ids.map((x) => str(x)).filter(Boolean) : []
  if (a.wave != null && str(a.wave)) {
    const w = str(a.wave)
    const wave = (await api(`/api/corch/waves/${encodeURIComponent(w)}`)) as { group?: string }
    const part = (group: string) =>
      api(`/api/corch/workers${qs({ group, brief: 1, all: a.all === true ? 1 : undefined })}`)
    const [manager, tasks] = await Promise.all([part(`mgr-${w}`), part(wave?.group ?? '')])
    return [...(manager as unknown[]), ...(tasks as unknown[])]
  }
  if (a.id != null && str(a.id) && a.report !== true)
    return api(
      `/api/corch/workers/${encodeURIComponent(str(a.id))}${qs({ wait: wait > 0 ? wait : undefined, seen_by: seenBy })}`,
    )
  const limit =
    a.limit != null && Number.isFinite(Number(a.limit))
      ? Math.max(0, Math.floor(Number(a.limit)))
      : group
        ? undefined
        : RECENT_FINISHED
  const report = a.report === true
  const chars = Number(a.chars)
  return api(
    `/api/corch/workers${qs({
      group,
      id: report && a.id != null && str(a.id) ? str(a.id) : undefined,
      ids: ids.length ? ids.join(',') : undefined,
      active: a.active === true ? 1 : undefined,
      limit: ids.length ? undefined : limit,
      brief: report ? undefined : 1,
      all: a.all === true ? 1 : undefined,
      report: report ? 1 : undefined,
      chars: report && Number.isFinite(chars) && chars >= 0 ? Math.floor(chars) : undefined,
      wait: wait > 0 ? wait : undefined,
      seen_by: seenBy,
    })}`,
  )
}

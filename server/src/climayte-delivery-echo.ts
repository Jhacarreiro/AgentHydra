import { type CliMayteAttempt, plainUserText } from './climayte-lib'

type Delivery = NonNullable<CliMayteAttempt['deliveries']>[number]
const posting = new WeakSet<Delivery>()

export const beginDeliveryPost = (entry: Delivery): void => {
  posting.add(entry)
}
export const endDeliveryPost = (entry: Delivery): void => {
  posting.delete(entry)
}
export const hasDeliveryPosts = (at: Pick<CliMayteAttempt, 'deliveries'>): boolean =>
  at.deliveries?.some((entry) => posting.has(entry)) ?? false

/** Observe the complete stdout stream, before its bounded event tail discards anything. The
 *  first genuine user echo is the launch prompt. Later matching echoes mark existing delivery
 *  receipts only; the observer keeps no message text and does not checkpoint on every event. */
export function createDeliveryEchoObserver(
  at: Pick<CliMayteAttempt, 'deliveries'>,
): (raw: unknown) => void {
  let promptSeen = false
  // A replay must consume even receipts already marked read, in order: two identical messages
  // are distinct deliveries, and the first one's old echo cannot confirm the second one.
  const observed = new WeakSet<Delivery>()
  return (raw) => {
    const ev = raw as {
      type?: unknown
      parent_tool_use_id?: unknown
      isMeta?: unknown
      message?: { content?: unknown }
    } | null
    if (ev?.type !== 'user' || ev.parent_tool_use_id || ev.isMeta === true) return
    const text = plainUserText(ev.message?.content)
    if (text === null || !text.trim() || /^\s*Stop hook feedback:/.test(text)) return
    if (!promptSeen) {
      promptSeen = true
      return
    }
    // Concurrent POSTs can acquire the native runner's stdin lock in a different order.
    // Match the earliest still-unobserved occurrence of this text, not an unrelated prefix.
    const next = at.deliveries?.find((d) => d.text === text && !observed.has(d))
    if (!next) return
    // Echoes can be read before the runner's HTTP acknowledgement has arrived.
    next.read = true
    observed.add(next)
  }
}

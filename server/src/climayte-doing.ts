// What a CliMayte worker is doing now and since when, for the Desk's task rows: read from the worker's
// own state (its hold reason, its newest summary line, when the state or that line last changed), so
// it costs no model call.
import type { CliMayteWorker } from './climayte-lib'

const DOING_MAX = 120

/** The state a worker is in, for the time it has been in it. A held worker's key is the head of its
 *  error, so the figures in the reason (the CPU share each tick) do not restart the clock. */
export function stateKey(w: CliMayteWorker): string {
  if (w.status === 'queued' || w.status === 'waiting')
    return `${w.status}|${(w.error ?? '').split(/[:.]/)[0]}`
  return w.status
}

const cut = (s: string): string => (s.length > DOING_MAX ? `${s.slice(0, DOING_MAX - 3)}...` : s)

export function doingOf(w: CliMayteWorker): { doing: string | null; doingSince: number | null } {
  const stateSince = w.stateAt?.at ?? w.createdAt ?? null
  switch (w.status) {
    case 'running': {
      const since = Math.max(w.stepAt ?? 0, stateSince ?? 0) || null
      return w.lastActivity
        ? { doing: cut(w.lastActivity), doingSince: since }
        : { doing: 'Working', doingSince: since }
    }
    case 'checking':
      return { doing: 'Checking its work', doingSince: stateSince }
    case 'queued':
    case 'waiting':
      return {
        doing: w.error
          ? cut(w.error.split(/\.\s/)[0]!.trim())
          : w.status === 'waiting'
            ? 'Waiting'
            : 'Queued',
        doingSince: stateSince,
      }
    default:
      return { doing: null, doingSince: null }
  }
}

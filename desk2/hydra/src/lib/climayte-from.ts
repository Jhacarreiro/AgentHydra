// Who dispatched a CliMayte task, for the list's From cell and the detail's From line. The server gives the
// ids and a chat's title (climayte-origin.ts); a worker's title comes from the tasks already loaded.
import type { CliMayteWorkerView } from './api'

export type CliMayteFrom =
  /** A chat: its title, or its short session id while the title is unknown. */
  | { kind: 'chat'; sessionId: string; label: string }
  /** A CliMayte worker that dispatched it, labelled with that worker's title (its id while the title is not loaded). */
  | { kind: 'worker'; workerId: string; label: string }
  /** Nothing traced: the task's group names it in the hover. */
  | { kind: 'untraced'; group: string }

type FromFields = Pick<CliMayteWorkerView, 'group' | 'originSessionId' | 'originWorkerId' | 'originTitle'>

export function climayteFrom(
  w: FromFields,
  tasks: ReadonlyArray<Pick<CliMayteWorkerView, 'id' | 'title'>>,
): CliMayteFrom {
  if (w.originWorkerId) {
    const title = tasks.find((x) => x.id === w.originWorkerId)?.title?.trim()
    return { kind: 'worker', workerId: w.originWorkerId, label: title || w.originWorkerId }
  }
  if (w.originSessionId) {
    return {
      kind: 'chat',
      sessionId: w.originSessionId,
      label: w.originTitle?.trim() || w.originSessionId.slice(0, 8),
    }
  }
  return { kind: 'untraced', group: w.group }
}

/** The words a From shows: the label (or Not traced, muted, with its group in the hover). */
export function climayteFromText(
  f: CliMayteFrom,
  t: (key: string, named?: Record<string, string>) => string,
): { text: string; muted: boolean; hint: string } {
  if (f.kind === 'untraced') {
    return {
      text: t('climayte.fromNotTraced'),
      muted: true,
      hint: t('climayte.fromNotTracedHint', { group: f.group }),
    }
  }
  return { text: f.label, muted: false, hint: t('climayte.fromHint', { label: f.label }) }
}

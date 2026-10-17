// What a Settings → Connectors row shows and offers, as pure functions of the connector's view.
import type { ConnectorView } from '@shared/connectors'

export const FAST_POLL_MS = 3000
export const SLOW_POLL_MS = 15000

export type Tone = 'ok' | 'busy' | 'bad' | 'idle'

/** The Status column's word; why it failed and an install's progress are its tooltip and its details. */
export function stateLabel(v: ConnectorView): string {
  switch (v.state) {
    case 'running':
      return 'Running'
    case 'installed':
      return 'Stopped'
    case 'absent':
      return 'Not installed'
    case 'installing':
      return 'Installing…'
    case 'starting':
      return 'Starting…'
    case 'failed':
      return 'Failed'
  }
}

export function stateTone(v: ConnectorView): Tone {
  if (v.state === 'running') return 'ok'
  if (v.state === 'installing' || v.state === 'starting') return 'busy'
  if (v.state === 'failed') return 'bad'
  return 'idle'
}

export const isBusy = (v: ConnectorView): boolean => v.state === 'installing' || v.state === 'starting'

/** Which buttons the row shows. */
export function rowButtons(v: ConnectorView): { install: boolean; start: boolean; open: boolean } {
  return {
    install: v.installable && (v.state === 'absent' || v.state === 'failed'),
    start: v.state === 'installed',
    open: v.pane && v.state === 'running' && !!v.url
  }
}

/** A connector not on this PC gives chats nothing, so its switch is off and cannot be turned on until it is installed. */
export const canTurnOn = (v: ConnectorView): boolean => v.state !== 'absent' && v.state !== 'installing'

export const typeLabel = (v: ConnectorView): string => (v.builtIn ? 'Built in' : 'App')

/** Why it is absent or not answering, when the label alone does not say. */
export const note = (v: ConnectorView): string | null => ((v.state === 'absent' || v.state === 'installed') && v.reason ? v.reason : null)

export const versionLabel = (v: ConnectorView): string | null => (v.version ? (v.version.startsWith('v') ? v.version : `v${v.version}`) : null)

/** Poll every 3 s while any connector installs or starts, else every 15 s. */
export const pollDelay = (views: ConnectorView[]): number => (views.some(isBusy) ? FAST_POLL_MS : SLOW_POLL_MS)

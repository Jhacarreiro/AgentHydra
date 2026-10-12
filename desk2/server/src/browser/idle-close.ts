// Closes a saved-browser Chrome that only a headless agent launched once nothing has driven it for IDLE_CLOSE_MS. A visible
// window, a live view in the Browser pane, or a page a live chat is using keeps it open; the next browser call relaunches it.

import { anyLiveSession, closeBrowser, liveBrowser, pageTabs } from './cdp'
import { readLedger } from './ownership'
import { launchedHeadless } from './agent/session'
import { makeLiveness, profileFolders, type Liveness } from './tab-sweep'
import { storeRoot } from './store'

export const IDLE_CLOSE_MS = 10 * 60_000
export const IDLE_CHECK_MS = 60_000

const BLANK = 'about:blank'

export interface IdleCloseDeps {
  liveBrowser(dir: string): Promise<{ port: number } | null>
  pages(port: number): Promise<{ id: string; url: string }[]>
  owners(dir: string): Map<string, { chat: string }>
  headless(dir: string): boolean
  liveView(port: number): boolean
  liveness: Liveness
  close(dir: string): Promise<boolean>
  log(msg: string): void
}

/** Returns sweep(dirs): closes the idle headless profiles among dirs and answers the folders closed. The clock is per folder and restarts whenever a check fails. */
export function makeIdleCloser(deps: IdleCloseDeps, now: () => number = Date.now): (dirs: readonly string[]) => Promise<string[]> {
  const idleSince = new Map<string, number>()

  const idle = async (dir: string): Promise<{ port: number } | null> => {
    const live = await deps.liveBrowser(dir)
    if (!live || !deps.headless(dir) || deps.liveView(live.port)) return null
    const owners = deps.owners(dir)
    const pages = await deps.pages(live.port)
    const busy = pages.some((p) => p.url !== BLANK && !(owners.has(p.id) && deps.liveness(owners.get(p.id)!.chat) === false))
    return busy ? null : live
  }

  return async (dirs) => {
    const closed: string[] = []
    for (const dir of dirs) {
      if (!(await idle(dir))) {
        idleSince.delete(dir)
        continue
      }
      const since = idleSince.get(dir) ?? now()
      idleSince.set(dir, since)
      if (now() - since < IDLE_CLOSE_MS) continue
      if (!(await idle(dir))) {
        idleSince.delete(dir)
        continue
      }
      if (await deps.close(dir)) {
        deps.log(`[desk] closed the idle headless browser in ${dir}: no call or live view for ${IDLE_CLOSE_MS / 60_000} minutes`)
        closed.push(dir)
      }
      idleSince.delete(dir)
    }
    return closed
  }
}

function profileDeps(liveness: Liveness): IdleCloseDeps {
  return {
    liveBrowser,
    pages: async (port) => (await pageTabs(port)).filter((t) => !t.url.startsWith('devtools:')),
    owners: (dir) => new Map([...readLedger(dir)].map(([id, row]) => [id, { chat: row.chat }])),
    headless: launchedHeadless,
    liveView: anyLiveSession,
    liveness,
    close: closeBrowser,
    log: (msg) => console.log(msg),
  }
}

/** One pass over Desk's saved profiles. The closer, and with it each folder's idle clock, lives across passes; only the
 *  chats' liveness is read afresh each time. */
export function makeIdleTick(o: {
  deskSessions: () => Promise<ReadonlySet<string>>
  root?: string
  deps?: (liveness: Liveness) => IdleCloseDeps
  now?: () => number
}): () => Promise<string[]> {
  let liveness: Liveness = () => null
  const sweep = makeIdleCloser((o.deps ?? profileDeps)((owner) => liveness(owner)), o.now)
  return async () => {
    liveness = makeLiveness(await o.deskSessions())
    return sweep(profileFolders(o.root ?? storeRoot()))
  }
}

/** Runs the idle close over Desk's saved profiles every IDLE_CHECK_MS (unref'd). Returns the stop. */
export function startIdleBrowserClose(o: { deskSessions: () => Promise<ReadonlySet<string>>; root?: string; everyMs?: number }): () => void {
  const pass = makeIdleTick(o)
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await pass()
    } catch (err) {
      console.error('[desk] the idle browser close failed:', err)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), o.everyMs ?? IDLE_CHECK_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}

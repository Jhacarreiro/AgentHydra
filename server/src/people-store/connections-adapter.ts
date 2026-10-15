// The ONE file that knows about Connections: Sign in with Connections (@cnct/connect, RFC 8252 loopback, tokens in a
// 0600 file under ~/.agenthydra) and the Data Locker that holds the people. Connections is changing the room per
// user and adding a company-shared scope, so everything locker-specific (key names, scope, limits) stays here.
import { join } from 'node:path'
import { createConnect, createLocker, type LockerClient, nodeFileStore } from '@cnct/connect'
import { agentHydraDir } from './this-pc'
import {
  HomeUnavailable,
  type PeopleHome,
  type PersonRecord,
  type PersonSummary,
  parseId,
  summaryOf,
} from './types'

/** AgentHydra's Connections app id (the OAuth client_id, which is also the locker appId). Empty until registered. */
export const CONNECTIONS_APP_ID = ''
export const APP_ID_ENV = 'AGENTHYDRA_CONNECTIONS_APP_ID'
export const SCOPES = ['openid', 'profile', 'email', 'photo']

/** Whose people: 'me' is the signed-in member's own room, anything else is a company id's shared set. */
export type PeopleScope = 'me' | (string & {})

export const appIdFor = (env: Record<string, string | undefined> = process.env): string =>
  (env[APP_ID_ENV] ?? '').trim() || CONNECTIONS_APP_ID

export const NOT_CONFIGURED =
  'Connections is not set up in this build yet. Your people stay on this PC.'
export const SIGNED_OUT = 'Sign in with Connections to use it.'

export interface ConnectionsAccount {
  name: string
  email: string | null
}

/** The parts of @cnct/connect the adapter uses, so a test can stand in for the sign-in. */
export interface ConnectLike {
  isSignedIn(): Promise<boolean>
  getAccessToken(): Promise<string>
  getUser(): Promise<{ name?: string; email?: string }>
  signInLoopback(opts?: { openBrowser?: (url: string) => void | Promise<void> }): Promise<unknown>
  signOut(opts?: { revoke?: boolean }): Promise<void>
}

export interface ConnectionsOptions {
  home?: string
  appId?: string
  scope?: PeopleScope
  connect?: ConnectLike
  /** A locker to use instead of the network one (tests pass createMemoryLocker()). */
  locker?: LockerClient
  openBrowser?: (url: string) => void | Promise<void>
}

/** The locker key of one person. A company scope gets its own prefix, so a shared set never mixes with 'me'. */
export const lockerKey = (scope: PeopleScope, id: string): string =>
  scope === 'me' ? `person:${id}` : `company:${scope}:person:${id}`

export interface ConnectionsAdapter {
  configured: boolean
  signedIn(): Promise<boolean>
  account(): Promise<ConnectionsAccount | null>
  signIn(): Promise<ConnectionsAccount | null>
  signOut(): Promise<void>
  /** The people home over the locker; its calls throw HomeUnavailable, in words, when not configured or signed out. */
  home(): PeopleHome
}

export function createConnectionsAdapter(opts: ConnectionsOptions = {}): ConnectionsAdapter {
  const appId = opts.appId ?? appIdFor()
  const scope = opts.scope ?? 'me'
  const configured = appId !== '' || opts.locker !== undefined
  let connect = opts.connect
  const getConnect = (): ConnectLike => {
    if (!appId && !connect) throw new HomeUnavailable(NOT_CONFIGURED)
    connect ??= createConnect({
      clientId: appId,
      redirectUri: 'http://127.0.0.1/oauth/callback',
      scopes: SCOPES,
      store: nodeFileStore(join(agentHydraDir(opts.home), 'connections.json')),
    }) as unknown as ConnectLike
    return connect
  }
  let locker = opts.locker
  const getLocker = async (): Promise<LockerClient> => {
    if (scope !== 'me') throw new HomeUnavailable('Company-shared people are not available yet.')
    if (locker) return locker
    const c = getConnect()
    if (!(await c.isSignedIn())) throw new HomeUnavailable(SIGNED_OUT)
    locker = createLocker({ appId, getToken: () => c.getAccessToken() })
    return locker
  }
  const readAll = async (): Promise<Record<string, unknown>> => {
    const doc = await (await getLocker()).get()
    const prefix = lockerKey(scope, '')
    return Object.fromEntries(Object.entries(doc.settings).filter(([k]) => k.startsWith(prefix)))
  }
  const decode = (raw: unknown): PersonRecord | null => {
    try {
      const r = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!r || typeof r !== 'object') return null
      const rec = r as PersonRecord
      const p = parseId(rec.id)
      if (!p || !rec.persona || typeof rec.persona !== 'object') return null
      return {
        ...rec,
        family: p.family,
        slug: p.slug,
        learnings: rec.learnings ?? [],
        brief: rec.brief ?? null,
      }
    } catch {
      // floor-ok: one unreadable locker entry is skipped, the rest still sync
      return null
    }
  }
  const accountOf = async (): Promise<ConnectionsAccount | null> => {
    if (!configured) return null
    if (opts.locker && !opts.connect) return { name: 'Connections account', email: null }
    const c = getConnect()
    if (!(await c.isSignedIn())) return null
    const u = await c.getUser()
    return { name: u.name || u.email || 'Connections account', email: u.email ?? null }
  }

  return {
    configured,
    async signedIn() {
      if (!configured) return false
      if (opts.locker && !opts.connect) return true
      return getConnect().isSignedIn()
    },
    account: accountOf,
    async signIn() {
      await getConnect().signInLoopback({ openBrowser: opts.openBrowser })
      return accountOf()
    },
    async signOut() {
      if (!configured) return
      await getConnect().signOut()
      locker = opts.locker
    },
    home(): PeopleHome {
      return {
        kind: 'connections',
        async list(): Promise<PersonSummary[]> {
          return Object.values(await readAll())
            .map(decode)
            .filter((r): r is PersonRecord => r !== null)
            .map(summaryOf)
            .sort((a, b) => a.id.localeCompare(b.id))
        },
        async get(id) {
          const all = await readAll()
          return decode(all[lockerKey(scope, id)])
        },
        async put(record) {
          await (await getLocker()).merge({ [lockerKey(scope, record.id)]: JSON.stringify(record) })
        },
        async delete(id) {
          await (await getLocker()).merge({ [lockerKey(scope, id)]: null })
        },
      }
    },
  }
}

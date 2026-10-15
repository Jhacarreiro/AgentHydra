// The people home on LunarWerx's people server: one doc per person, over HTTPS with the Sign in with Connections token.
// AGENTHYDRA_API_URL names AgentHydra's API (people are its first module); empty means this build is not set up for it.
import {
  type ConnectionsAccount,
  type ConnectionsSignIn,
  type ConnectLike,
  createConnectionsSignIn,
  SIGNED_OUT,
} from './connections-signin'
import {
  HomeUnavailable,
  type PeopleHome,
  type PersonRecord,
  type PersonSummary,
  parseId,
} from './types'

export const API_URL_ENV = 'AGENTHYDRA_API_URL'
export const NOT_CONFIGURED =
  'The LunarWerx people server is not set up in this build yet. Your people stay on this PC.'
const UNREACHABLE =
  "Could not reach LunarWerx's people server. Your people stay on this PC for now."

export const apiUrlFrom = (env: Record<string, string | undefined> = process.env): string =>
  (env[API_URL_ENV] ?? '').trim().replace(/\/+$/, '')

export interface PreferencesDoc {
  trainingUse: boolean
  termsVersion: string
}

export interface PeopleServerHome extends PeopleHome {
  getPreferences(): Promise<PreferencesDoc>
  setPreferences(prefs: PreferencesDoc): Promise<void>
  deleteAccount(): Promise<void>
  exportAll(): Promise<Uint8Array>
}

interface DocListing {
  docs: { id: string; version: number; bytes: number; updatedAt: string }[]
  nextCursor: string | null
}

/** A person id has a slash; the server's doc ids do not allow one, so the slash becomes a dot. */
const docIdOf = (id: string): string => id.replace('/', '.')

const idOf = (docId: string): string | null => {
  const dot = docId.indexOf('.')
  return dot < 0 ? null : `${docId.slice(0, dot)}/${docId.slice(dot + 1)}`
}

export function createPeopleServerHome(
  baseUrl: string,
  signIn: ConnectionsSignIn,
): PeopleServerHome {
  const versions = new Map<string, number>()

  async function call(
    path: string,
    init: { method?: string; body?: string } = {},
    retried = false,
  ): Promise<Response> {
    if (!baseUrl) throw new HomeUnavailable(NOT_CONFIGURED)
    const token = await signIn.token()
    let res: Response
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body,
      })
    } catch {
      throw new HomeUnavailable(UNREACHABLE)
    }
    if (res.status !== 401) return res
    if (!retried) return call(path, init, true)
    throw new HomeUnavailable(SIGNED_OUT)
  }

  async function failed(res: Response): Promise<never> {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    const why = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new HomeUnavailable(`LunarWerx's people server said: ${why}`)
  }

  async function send(path: string, init?: { method?: string; body?: string }): Promise<Response> {
    const res = await call(path, init)
    if (!res.ok) return failed(res)
    return res
  }

  const json = async <T>(path: string, init?: { method?: string; body?: string }): Promise<T> =>
    (await send(path, init)).json() as Promise<T>

  async function versionOf(docId: string): Promise<number> {
    const res = await call(`/v1/people/docs/${docId}`)
    if (res.status === 404) return 0
    if (!res.ok) return failed(res)
    const { version } = (await res.json()) as { version: number }
    return version
  }

  const decode = (id: string, doc: unknown): PersonRecord | null => {
    const p = parseId(id)
    const rec = doc as PersonRecord | null
    if (!p || !rec || typeof rec !== 'object' || !rec.persona || typeof rec.persona !== 'object')
      return null
    return {
      ...rec,
      id,
      family: p.family,
      slug: p.slug,
      learnings: rec.learnings ?? [],
      brief: rec.brief ?? null,
    }
  }

  return {
    kind: 'connections',
    async list(): Promise<PersonSummary[]> {
      const out: PersonSummary[] = []
      let cursor: string | null = null
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
        const page: DocListing = await json<DocListing>(`/v1/people/docs${query}`)
        for (const d of page.docs) {
          const id = idOf(d.id)
          const p = id ? parseId(id) : null
          if (!id || !p) continue
          versions.set(d.id, d.version)
          // The list carries no persona, so the name is the slug until the doc is read.
          out.push({ id, family: p.family, slug: p.slug, name: p.slug, updatedAt: d.updatedAt })
        }
        cursor = page.nextCursor
      } while (cursor)
      return out.sort((a, b) => a.id.localeCompare(b.id))
    },
    async get(id) {
      if (!parseId(id)) return null
      const docId = docIdOf(id)
      const res = await call(`/v1/people/docs/${docId}`)
      if (res.status === 404) return null
      if (!res.ok) return failed(res)
      const body = (await res.json()) as { doc: unknown; version: number }
      versions.set(docId, body.version)
      return decode(id, body.doc)
    },
    async put(record) {
      if (!parseId(record.id)) throw new Error(`not a person id: ${record.id}`)
      const docId = docIdOf(record.id)
      const write = (baseVersion: number) =>
        call(`/v1/people/docs/${docId}`, {
          method: 'POST',
          body: JSON.stringify({ doc: record, baseVersion }),
        })
      let res = await write(versions.get(docId) ?? (await versionOf(docId)))
      if (res.status === 409) {
        const { currentVersion } = (await res.json()) as { currentVersion: number }
        res = await write(currentVersion)
        if (res.status === 409)
          throw new HomeUnavailable(
            'This person changed on another device at the same time. Sync again.',
          )
      }
      if (!res.ok) return failed(res)
      const { version } = (await res.json()) as { version: number }
      versions.set(docId, version)
    },
    async delete(id) {
      if (!parseId(id)) return
      const docId = docIdOf(id)
      const res = await call(`/v1/people/docs/${docId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) return failed(res)
      versions.delete(docId)
    },
    getPreferences: () => json<PreferencesDoc>('/v1/me/preferences'),
    async setPreferences(prefs) {
      await send('/v1/me/preferences', { method: 'PUT', body: JSON.stringify(prefs) })
    },
    async deleteAccount() {
      await send('/v1/me', { method: 'DELETE' })
      versions.clear()
    },
    async exportAll() {
      return new Uint8Array(await (await send('/v1/me/export')).arrayBuffer())
    },
  }
}

export interface PeopleServerAdapter {
  configured: boolean
  signedIn(): Promise<boolean>
  account(): Promise<ConnectionsAccount | null>
  signIn(): Promise<ConnectionsAccount | null>
  signOut(): Promise<void>
  home(): PeopleServerHome
}

export interface PeopleServerAdapterOptions {
  baseUrl?: string
  home?: string
  connect?: ConnectLike
  openBrowser?: (url: string) => void | Promise<void>
}

export function createPeopleServerAdapter(
  opts: PeopleServerAdapterOptions = {},
): PeopleServerAdapter {
  const baseUrl = opts.baseUrl ?? apiUrlFrom()
  const signIn = createConnectionsSignIn(opts)
  const home = createPeopleServerHome(baseUrl, signIn)
  return {
    configured: baseUrl !== '',
    signedIn: async () => baseUrl !== '' && (await signIn.signedIn()),
    account: () => signIn.account(),
    async signIn() {
      if (!baseUrl) throw new HomeUnavailable(NOT_CONFIGURED)
      return signIn.signIn()
    },
    signOut: () => signIn.signOut(),
    home: () => home,
  }
}

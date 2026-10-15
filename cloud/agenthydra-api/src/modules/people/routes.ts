import { isDocId } from '../../limits'
import { HttpError, json, type Route } from '../../router'
import { PeopleStore, StoreError } from './store'

/** Maps store errors to HTTP errors so every handler stays a straight line. */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (e instanceof StoreError) throw new HttpError(e.status, e.message, e.hint, e.extra)
    throw e
  }
}

const docId = (s: string | undefined): string => {
  if (!s || !isDocId(s)) throw new HttpError(400, 'bad doc id', 'Use 1-128 of A-Z a-z 0-9 . _ -')
  return s
}

export function peopleRoutes(store: PeopleStore): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/v1\/people\/docs$/,
      handler: async (c) => {
        const cursor = c.url.searchParams.get('cursor')
        if (cursor !== null && !isDocId(cursor)) throw new HttpError(400, 'bad cursor')
        return json(200, await guard(store.list(c.sub, cursor)))
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/people\/docs\/([^/]+)$/,
      handler: async (c) => {
        const r = await guard(store.read(c.sub, docId(c.params[0])))
        return r ? json(200, r) : json(404, { error: 'not found', hint: '' })
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/people\/docs\/([^/]+)$/,
      write: true,
      body: true,
      handler: async (c) => {
        const id = docId(c.params[0])
        const b = c.body as { doc?: unknown; baseVersion?: unknown } | null
        if (
          !b ||
          typeof b !== 'object' ||
          b.doc === undefined ||
          !Number.isInteger(b.baseVersion) ||
          (b.baseVersion as number) < 0
        )
          throw new HttpError(400, 'bad body', 'Send { doc, baseVersion } with baseVersion >= 0.')
        const r = await guard(store.write(c.sub, id, b.doc, b.baseVersion as number))
        return json(200, r)
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/v1\/people\/docs\/([^/]+)$/,
      write: true,
      handler: async (c) => {
        const ok = await guard(store.remove(c.sub, docId(c.params[0])))
        return ok ? json(200, { ok: true }) : json(404, { error: 'not found', hint: '' })
      },
    },
  ]
}

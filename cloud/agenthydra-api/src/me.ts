import type { Db } from './db'
import { HttpError, json, type Route } from './router'
import { PeopleStore } from './modules/people/store'
import { zip } from './zip'

/** Each module registers how it erases and exports its own rows. */
export interface MeModule {
  name: string
  erase: (tx: Db) => Promise<void>
  exportFiles: (sub: string) => Promise<{ name: string; data: Uint8Array }[]>
}

export function peopleMeModule(store: PeopleStore): MeModule {
  return {
    name: 'people',
    erase: (tx) => store.eraseInTx(tx),
    exportFiles: async (sub) =>
      (await store.exportDocs(sub)).map((d) => ({
        name: `people/${d.id}.json`,
        data: new TextEncoder().encode(JSON.stringify({ version: d.version, doc: d.doc }, null, 2)),
      })),
  }
}

export function meRoutes(store: PeopleStore, modules: MeModule[]): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/v1\/me\/preferences$/,
      handler: async (c) => json(200, await store.getPreferences(c.sub)),
    },
    {
      method: 'PUT',
      pattern: /^\/v1\/me\/preferences$/,
      write: true,
      body: true,
      handler: async (c) => {
        const b = c.body as { trainingUse?: unknown; termsVersion?: unknown } | null
        if (
          !b ||
          typeof b.trainingUse !== 'boolean' ||
          typeof b.termsVersion !== 'string' ||
          b.termsVersion.length > 64
        )
          throw new HttpError(400, 'bad body', 'Send { trainingUse: boolean, termsVersion: string }.')
        await store.setPreferences(c.sub, { trainingUse: b.trainingUse, termsVersion: b.termsVersion })
        return json(200, { trainingUse: b.trainingUse, termsVersion: b.termsVersion })
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/v1\/me$/,
      write: true,
      handler: async (c) => {
        await store.eraseUser(
          c.sub,
          modules.map((m) => m.erase),
          c.requestId,
        )
        return json(200, { ok: true })
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/me\/export$/,
      handler: async (c) => {
        const files = (await Promise.all(modules.map((m) => m.exportFiles(c.sub)))).flat()
        return new Response(zip(files), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="agenthydra-export.zip"',
            'cache-control': 'no-store',
          },
        })
      },
    },
  ]
}

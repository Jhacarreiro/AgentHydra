// server/src/addon-loader.ts - imports a module from the private sue-dredd checkout in-process and calls its factory with a
// host object. Absent means null, quietly; a module that throws is logged once and is null. The one resolver for the
// checkout is sue-dredd-home.ts.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_ROOT } from './config'
import { findSueDredd } from './sue-dredd-home'

export interface AddonEnv {
  env?: Record<string, string | undefined>
  appRoot?: string
}

const logged = new Set<string>()

function complain(file: string, err: unknown): void {
  const line = `[agenthydra] add-on ${file} not loaded: ${String(err)}`
  if (logged.has(line)) return
  logged.add(line)
  console.error(line)
}

/** Imports `file`, calls its named export with `host`, and returns what it answers; null when the file is absent. */
export async function callAddon<T>(
  file: string,
  exportName: string,
  host: unknown,
): Promise<T | null> {
  if (!existsSync(file)) return null
  try {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod[exportName] !== 'function') throw new Error(`${file} exports no ${exportName}`)
    return (await mod[exportName](host)) as T
  } catch (err) {
    complain(file, err)
    return null
  }
}

/** The add-on at `entry` (a path inside the sue-dredd checkout), or null when there is no such checkout or file. */
export async function loadAddon<T>(
  entry: string,
  exportName: string,
  host: unknown,
  opts: AddonEnv = {},
): Promise<T | null> {
  const home = findSueDredd(entry, opts.env ?? process.env, opts.appRoot ?? APP_ROOT)
  return home ? callAddon<T>(join(home, entry), exportName, host) : null
}

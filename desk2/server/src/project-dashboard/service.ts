// The project dashboards Desk 2 fills: each project's spec (SPEC_FILE in its checkout) read when it changes, each
// source read at most once per the spec's refreshMinutes and only while someone asks (the page polls while it is on
// screen; Project Hydra reads when its page does), and the last good answer of every source kept on disk, so a
// restart or a source that is down still shows the last numbers, marked late.

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  checkFeed,
  checkSectionFeed,
  checkSpec,
  DEFAULT_REFRESH_MINUTES,
  DEFAULT_SHOW,
  type DashboardFeed,
  type DashboardSpec,
  type FilledSection,
  isRanged,
  type ProjectDashboard,
  type ProjectDashboardList,
  RANGES,
  type RangeId,
  SPEC_FILE,
  type SourceState,
  TYPE_ICON
} from '@shared/project-dashboard'
import { checkoutOf } from '../projects/choices'
import { readSource, SourceError, sourceLabel } from './sources'

export class NoSpecError extends Error {}

interface SourceRead {
  feed: DashboardFeed | null
  fetchedAt: number | null
  error: string | null
  lastTry: number
  inFlight: Promise<void> | null
}

interface Entry {
  workspace: string
  specFile: string
  mtimeMs: number
  spec: DashboardSpec | null
  problems: string[]
  reads: Map<string, SourceRead>
}

const slash = (p: string) => p.replace(/\\/g, '/')
/** The projects kept in memory at once; the oldest is dropped past this (its last answers stay on disk). */
const MAX_ENTRIES = 64

/** `home` is Desk's home folder: the last good answers are kept under it. */
export function dashboardService(opts: { home: string }) {
  const now = Date.now
  const entries = new Map<string, Entry>()
  const dir = join(opts.home, 'project-dashboards')
  const keyOf = (workspace: string) => createHash('sha1').update(process.platform === 'win32' ? workspace.toLowerCase() : workspace).digest('hex').slice(0, 16)
  const cacheFile = (workspace: string) => join(dir, `${keyOf(workspace)}.json`)

  async function loadCache(workspace: string): Promise<Map<string, SourceRead>> {
    const reads = new Map<string, SourceRead>()
    try {
      const saved = JSON.parse(await readFile(cacheFile(workspace), 'utf8')) as Record<string, { feed: unknown; fetchedAt: number }>
      for (const [id, s] of Object.entries(saved)) {
        const got = checkFeed(s.feed)
        if (got.ok && typeof s.fetchedAt === 'number') reads.set(id, { feed: got.value, fetchedAt: s.fetchedAt, error: null, lastTry: 0, inFlight: null })
      }
    } catch {
      // floor-ok: nothing kept yet, or a file from another version; the sources are read again
    }
    return reads
  }

  async function saveCache(e: Entry): Promise<void> {
    const out: Record<string, { feed: DashboardFeed; fetchedAt: number }> = {}
    for (const [id, r] of e.reads) if (r.feed && r.fetchedAt) out[id] = { feed: r.feed, fetchedAt: r.fetchedAt }
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(cacheFile(e.workspace), JSON.stringify(out))
    } catch {
      // floor-ok: the numbers still show from memory; the next good read tries again
    }
  }

  /** The entry for a folder's checkout, its spec re-read when the file changed. Throws NoSpecError when it has none. */
  async function entryFor(cwd: string): Promise<Entry> {
    const workspace = checkoutOf(cwd)
    const specFile = join(workspace, SPEC_FILE)
    let mtimeMs: number
    try {
      mtimeMs = (await stat(specFile)).mtimeMs
    } catch {
      entries.delete(workspace)
      throw new NoSpecError(`no dashboard spec at ${slash(specFile)}`)
    }
    let e = entries.get(workspace)
    if (e && e.mtimeMs === mtimeMs) return e
    let spec: DashboardSpec | null = null
    let problems: string[]
    try {
      const got = checkSpec(JSON.parse(await readFile(specFile, 'utf8')))
      spec = got.spec
      problems = got.problems
    } catch (err) {
      problems = [`the spec is not JSON: ${(err as Error).message}`]
    }
    const reads = e?.reads ?? (await loadCache(workspace))
    // A spec edit reads its sources again at once: what they are asked may have changed.
    for (const r of reads.values()) r.lastTry = 0
    e = { workspace, specFile, mtimeMs, spec, problems, reads }
    entries.delete(workspace)
    entries.set(workspace, e)
    const oldest = entries.keys().next().value
    if (entries.size > MAX_ENTRIES && oldest !== undefined) entries.delete(oldest)
    return e
  }

  function startRead(e: Entry, id: string): Promise<void> {
    const source = e.spec?.sources[id]
    let r = e.reads.get(id)
    if (!r) {
      r = { feed: null, fetchedAt: null, error: null, lastTry: 0, inFlight: null }
      e.reads.set(id, r)
    }
    if (r.inFlight || !source) return r.inFlight ?? Promise.resolve()
    const state = r
    state.lastTry = now()
    state.inFlight = readSource(source, e.workspace)
      .then((raw) => {
        const got = checkFeed(raw)
        if (!got.ok) throw new SourceError(`its answer does not fit the dashboard feed: ${got.problems.join('; ')}`)
        state.feed = got.value
        state.fetchedAt = now()
        state.error = null
        void saveCache(e)
      })
      .catch((err: unknown) => {
        state.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        state.inFlight = null
      })
    return state.inFlight
  }

  function usedSources(e: Entry): string[] {
    return [...new Set((e.spec?.sections ?? []).map((s) => s.source!))]
  }

  /** Starts the reads that are due; with `force`, every source is read now. */
  function readDue(e: Entry, force: boolean): Promise<void>[] {
    const every = (e.spec?.refreshMinutes ?? DEFAULT_REFRESH_MINUTES) * 60_000
    const out: Promise<void>[] = []
    for (const id of usedSources(e)) {
      const r = e.reads.get(id)
      if (force || !r || now() - r.lastTry >= every) out.push(startRead(e, id))
      else if (r.inFlight) out.push(r.inFlight)
    }
    return out
  }

  function fill(e: Entry): ProjectDashboard {
    const spec = e.spec
    const sections: FilledSection[] = []
    const ranges = new Set<RangeId>()
    const problems = [...e.problems]
    for (const s of spec?.sections ?? []) {
      const r = e.reads.get(s.source!)
      const label = spec ? sourceLabel(spec.sources[s.source!]) : s.source!
      const key = s.key ?? s.id
      let feed: FilledSection['feed'] = null
      let missing: string | null = null
      if (r?.feed) {
        const raw = r.feed.sections[key]
        if (raw === undefined) missing = `${label} has no ${key} in its answer`
        else {
          const got = checkSectionFeed(s.type, raw, `sections.${key}`)
          feed = got.feed
          if (!feed) missing = `${label} answered ${key} in a shape a ${s.type} section cannot draw: ${got.problems[0]}`
          else if (got.problems.length) problems.push(...got.problems.slice(0, 3).map((p) => `${label}: ${p}`))
          if (feed && isRanged(feed)) for (const k of Object.keys(feed.ranges)) ranges.add(k as RangeId)
        }
      } else if (r?.error) missing = `Could not read ${label}: ${r.error}`
      sections.push({ id: s.id, type: s.type, title: s.title, icon: s.icon ?? TYPE_ICON[s.type], show: s.show ?? DEFAULT_SHOW, attention: !!s.attention, feed, missing })
    }
    const sources: SourceState[] = usedSources(e).map((id) => {
      const r = e.reads.get(id)
      const src = spec?.sources[id]
      return {
        id,
        label: src ? sourceLabel(src) : id,
        fetchedAt: r?.fetchedAt ? new Date(r.fetchedAt).toISOString() : null,
        generatedAt: r?.feed?.generatedAt ?? null,
        everyMinutes: r?.feed?.everyMinutes ?? null,
        error: r?.error ?? null,
        reading: !!r?.inFlight
      }
    })
    const version = [
      e.mtimeMs,
      ...usedSources(e).map((id) => {
        const r = e.reads.get(id)
        return `${id}:${r?.fetchedAt ?? ''}:${r?.error ?? ''}:${r?.inFlight ? 1 : 0}`
      })
    ].join('|')
    return {
      version,
      workspace: slash(e.workspace),
      specFile: slash(e.specFile),
      title: spec?.title ?? basename(e.workspace),
      refreshMinutes: spec?.refreshMinutes ?? DEFAULT_REFRESH_MINUTES,
      ranges: RANGES.filter((r) => ranges.has(r)),
      sections,
      sources,
      problems
    }
  }

  return {
    /** A folder's dashboard, filled from what its sources last answered; the reads that are due start now. With `waitMs`, a first read is awaited that long. */
    async get(cwd: string, waitMs = 0): Promise<ProjectDashboard> {
      const e = await entryFor(cwd)
      const pending = readDue(e, false)
      const unread = usedSources(e).some((id) => !e.reads.get(id)?.feed && !e.reads.get(id)?.error)
      if (waitMs > 0 && unread && pending.length) await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, waitMs))])
      return fill(e)
    },

    /** Reads every source now and answers once they are in (or `waitMs` passed). */
    async refresh(cwd: string, waitMs = 30_000): Promise<ProjectDashboard> {
      const e = await entryFor(cwd)
      await Promise.race([Promise.all(readDue(e, true)), new Promise((r) => setTimeout(r, waitMs))])
      return fill(e)
    },

    /** The checkouts among these folders that have a spec, each with its title. */
    async list(folders: string[]): Promise<ProjectDashboardList> {
      const seen = new Set<string>()
      const dashboards: ProjectDashboardList['dashboards'] = []
      for (const f of folders) {
        const workspace = checkoutOf(f)
        const k = process.platform === 'win32' ? workspace.toLowerCase() : workspace
        if (seen.has(k)) continue
        seen.add(k)
        try {
          const e = await entryFor(workspace)
          dashboards.push({ workspace: slash(workspace), title: e.spec?.title ?? basename(workspace) })
        } catch {
          // floor-ok: no spec in this checkout
        }
      }
      return { dashboards }
    }
  }
}

export type DashboardService = ReturnType<typeof dashboardService>

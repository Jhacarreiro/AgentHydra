// The All tab's one ranking across the kinds. Owner, 2026-10-10: "for the All tab in instances, I would
// like the desktop, CLI and free combined into a single table. Which then just indicates whether or not
// they are CLI, desktop, or free, but sorted by tokens, so I can see how they rank among each other."
//
// Each source (Claude, Codex and DeepSeek desktop rows; CLI; Free) keeps its own rows and components,
// and reports the sort values of every visible row, for every sortable column (useMergedOrderSource).
// The provider sorts those reports together with the same useSortable the tables use, under the same
// persisted header sort, so missing values still sort last, ties keep the source order, and the order
// settles the same way. Each row then gets its place as `order` in the one grid InstanceTable lays out
// in merged mode (components/InstanceTable.vue). It is on only while the All tab shows more than one
// kind; a source's report is dropped when it unmounts or the tab leaves All.
import {
  computed,
  type ComputedRef,
  type CSSProperties,
  inject,
  type InjectionKey,
  onScopeDispose,
  provide,
  shallowRef,
  triggerRef,
  watchEffect,
} from 'vue'
import { type PersistedSort, type SortableColumn, useSortable } from '@/composables/useSortable'

export type MergedSource = 'claude' | 'codex' | 'dsh' | 'cli' | 'free'
type MergedValue = string | number | boolean | null | undefined
interface MergedReport {
  /** Identifies the row within its source. */
  key: string
  /** The row's sort value for every sortable column key. */
  values: Record<string, MergedValue>
}

interface MergedEntry {
  /** `${source}:${key}`: one row across every source. */
  id: string
  values: Record<string, MergedValue>
}

/** The order a tie keeps: today's blocks, Claude first. */
const SOURCE_ORDER: MergedSource[] = ['claude', 'codex', 'dsh', 'cli', 'free']

export interface MergedOrderContext {
  /** Whether the All tab ranks its rows together (more than one kind is shown). */
  active: ComputedRef<boolean>
  /** Replaces one source's visible rows. */
  report: (source: MergedSource, rows: MergedReport[]) => void
  /** Drops one source's rows. */
  clear: (source: MergedSource) => void
  /** A row's place in the one ranking, or undefined while it is not ranked. */
  rank: (source: MergedSource, key: string) => number | undefined
}

export const MERGED_ORDER: InjectionKey<MergedOrderContext> = Symbol('merged-order')

/**
 * Provide the ranking to the sources below (InstancesView). `keys` is every column the ranking sorts by,
 * and `persisted` is the header's own remembered sort, so the merged order follows the one header.
 */
export function provideMergedOrder(opts: {
  active: ComputedRef<boolean>
  keys: readonly string[]
  persisted: PersistedSort
}): MergedOrderContext {
  // Not reactive on purpose: a source's watcher reports from inside its own effect, and a reactive
  // map read there would re-run that effect. `changed` is the one signal, poked by triggerRef.
  const reports = new Map<MergedSource, MergedReport[]>()
  const changed = shallowRef(0)

  const rows = computed<MergedEntry[]>(() => {
    changed.value
    if (!opts.active.value) return []
    return SOURCE_ORDER.flatMap((source) =>
      (reports.get(source) ?? []).map((row) => ({
        id: `${source}:${row.key}`,
        values: row.values,
      })),
    )
  })
  const columns: SortableColumn<MergedEntry>[] = opts.keys.map((key) => ({
    key,
    accessor: (row) => row.values[key],
  }))
  const { sortedRows } = useSortable(() => rows.value, columns, opts.persisted, {
    rowKey: (row) => row.id,
  })
  const ranks = computed(() => new Map(sortedRows.value.map((row, index) => [row.id, index])))

  const ctx: MergedOrderContext = {
    active: opts.active,
    report: (source, list) => {
      reports.set(source, list)
      triggerRef(changed)
    },
    clear: (source) => {
      if (reports.delete(source)) triggerRef(changed)
    },
    rank: (source, key) => ranks.value.get(`${source}:${key}`),
  }
  provide(MERGED_ORDER, ctx)
  return ctx
}

/**
 * A source's side of the ranking: its visible rows and their sort values, reported while the All tab
 * ranks them. Returns `orderStyle`, which a row's root takes as its style: `order` is its rank, and
 * undefined when the rows are not ranked together (every tab but All, or no provider above).
 */
export function useMergedOrderSource<Row>(
  source: MergedSource,
  opts: {
    rows: () => readonly Row[]
    rowKey: (row: Row) => string
    values: (row: Row) => Record<string, MergedValue>
    /** The provider when it is the calling component itself (InstancesView's own Claude rows), which
     *  cannot inject what it provides. Other sources inject it. */
    ctx?: MergedOrderContext
  },
) {
  const ctx = opts.ctx ?? inject(MERGED_ORDER, null)
  if (ctx) {
    watchEffect(() => {
      if (!ctx.active.value) {
        ctx.clear(source)
        return
      }
      ctx.report(
        source,
        opts.rows().map((row) => ({ key: opts.rowKey(row), values: opts.values(row) })),
      )
    })
    onScopeDispose(() => ctx.clear(source))
  }
  return {
    orderStyle: (row: Row): CSSProperties | undefined => {
      if (!ctx?.active.value) return undefined
      const rank = ctx.rank(source, opts.rowKey(row))
      return rank === undefined ? undefined : { order: rank }
    },
  }
}

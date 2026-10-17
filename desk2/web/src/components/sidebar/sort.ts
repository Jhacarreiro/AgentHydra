// How the sidebar's rows are ordered: one choice per window, read by both lists (the desk list in Sidebar.vue, the cloud
// list in cloud/store.ts), so turning the cloud button on or off moves nothing. Until now a row kept its saved place
// (order.ts) and a row not yet saved joined at the top, sorted by activity, so a message sent to a chat reshuffled the
// list (the owner, 2026-10-17: "Why do things in the sidebar keep changing order? ... I would prefer it to not change
// order"). The default is now the date each chat started, oldest on top, the way a list is made. 'name' and 'activity'
// are the other fixed orders; 'manual' is the saved order the rows are dragged into (rowDrag.ts), kept as a choice.
import { ref } from 'vue'

export const SORT_VALUES = ['started', 'name', 'activity', 'manual'] as const
export type SidebarSort = (typeof SORT_VALUES)[number]
/** The Filter menu's labels (cloud/FilterMenuItems.vue). */
export const SORT_LABELS: Record<SidebarSort, string> = {
  started: 'Date started (oldest first)',
  name: 'Name (A-Z)',
  activity: 'Last activity (newest first)',
  manual: 'Manual (drag to order)'
}
/** What the Filter menu's "Sort by" shows next to itself: the current choice, in a word or two. */
export const SORT_NAMES: Record<SidebarSort, string> = { started: 'Date started', name: 'Name', activity: 'Last activity', manual: 'Manual' }

const SORT_KEY = 'hydra-desk.sidebar.sort'

/** What a row sorts by: its title, when it started (null when nothing says), and its last activity. */
export interface RowFacts {
  title: string
  started: number | null
  activity: number
}

const byTitle = (a: RowFacts, b: RowFacts) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
// A row with no start time goes after the ones that have one.
const byStart = (a: RowFacts, b: RowFacts) => {
  const x = a.started ?? Infinity
  const y = b.started ?? Infinity
  return x === y ? 0 : x < y ? -1 : 1
}
const COMPARE: Record<Exclude<SidebarSort, 'manual'>, (a: RowFacts, b: RowFacts) => number> = {
  started: (a, b) => byStart(a, b) || byTitle(a, b),
  name: (a, b) => byTitle(a, b) || byStart(a, b),
  activity: (a, b) => b.activity - a.activity || byTitle(a, b)
}

/**
 * The items in the mode's order, as a new array. 'manual' returns them as given: the saved order is the caller's
 * (sidebar/logic.ts stableOrder). Ties keep the order they came in, so a sort never reshuffles equal rows.
 */
export function sortRows<T>(items: readonly T[], mode: SidebarSort, facts: (t: T) => RowFacts): T[] {
  if (mode === 'manual') return [...items]
  const compare = COMPARE[mode]
  return items.map((item) => ({ item, f: facts(item) })).sort((a, b) => compare(a.f, b.f)).map((x) => x.item)
}

function parseSort(stored: string | null | undefined): SidebarSort {
  return (SORT_VALUES as readonly string[]).includes(stored ?? '') ? (stored as SidebarSort) : 'started'
}

function createSort() {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  let stored: string | null = null
  try {
    stored = storage?.getItem(SORT_KEY) ?? null
  } catch {
    // storage blocked: the default holds for this window only
  }
  const sort = ref<SidebarSort>(parseSort(stored))
  /** Keeps `next` as the choice and remembers it for this window. */
  function set(next: SidebarSort): void {
    sort.value = next
    try {
      storage?.setItem(SORT_KEY, next)
    } catch {
      // storage full or blocked: the choice holds for this window only
    }
  }
  return { sort, set }
}

let one: ReturnType<typeof createSort> | null = null

/** The window's one sidebar sort. */
export function useSidebarSort(): ReturnType<typeof createSort> {
  if (!one) one = createSort()
  return one
}

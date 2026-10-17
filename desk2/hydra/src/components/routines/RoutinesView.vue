<template>
  <!-- Contract
    Core: 1 at first glance he knows what this is and what to do first: a failed or broken routine's header says
      its one reason, and its pill is the only red. 2 keep what he picked: the Settings > Managers > Routines words,
      Run now, the on/off switch, Edit, Mode, Move to central. 3 progressive disclosure: the header and the tiles
      first, the campaigns and the history under them, Details one tap deeper. 4 only a problem wears red or amber.
      5 name it, don't explain it: every number has its noun; no argv or path on the first screen (Details has them).
      6 ship what the reference app ships (GitHub Actions workflow runs), picked by the Purpose sentence.
    Keep: Settings > Managers > Routines cards stay as they are. This page carries over their state words (Running,
      Paused, Off, Ended, Broken, Awaiting approval, Failed, On schedule), Run now, Pause/Resume, last and next run,
      the AI description on each run, the run list, the Edit form, Mode and Move to central.
    Layout system: a left list (Desk's one sidebar; standalone, this view's own column) and one page on the right: a
      sticky header, tiles, optional campaigns, history, Details. Rows 32px with thin dividers; no card in a card.
    Purpose: Is each routine doing its job, and what needs me? Each row answers with its state dot and its next run;
      the header with its state, last run, success rate and runs; the history with each run's outcome and duration.
    Reference: GitHub Actions workflow runs. Built here: the state dot per row, a folder that shows its problem, and
      the history bars whose failed bar keeps a visible height.
    Every view: one filled button (Run now on a routine, Approve on a proposal). Menus grow from their button and close
      on a second tap or Escape.
    Icons: lucide (@lucide/vue) on every section and metric. Colour codes state only.
    Scroll: the list and the page each scroll on their own; the header of the page is sticky.
    Convention: text sizes text-ui, text-2xs, text-3xs; weights 400 and 500; sentence case; pill chips.
    Real counts: 11 routines today, plan for 40; runs up to hundreds (the history pages 50 at a time).
    Clarity, Words: the words of Desk's routine cards; durations, not clock times (exact time is the tooltip).
    Space: 16px page padding, 12px between sections, 8px between a tile's label and value.
    Action colors: Run now filled (primary); Pause, Resume, Edit, Load more outline or ghost; Discard destructive.
    Tiers: the list (tier 1), the header (tier 2), the tiles and history (tier 3), Details (tier 4).
    Exceptions: the proposal page (no history) and the empty state (one line, with its fix).
    Motion: the state dot pulses while a run runs; nothing else moves.
    Theme: the hydra kit theme (its tokens; never raw hex).
    Directions: one (the AgentHydra look, decided).
  -->
  <div class="flex h-full min-h-0 flex-row">
    <!-- Outside Desk this view draws Desk's sidebar's rows as its own left column (inside Desk the sidebar is Desk's). -->
    <nav
      v-if="!EMBEDDED"
      :aria-label="t('routines.title')"
      class="flex w-72 shrink-0 flex-col border-e border-border bg-sidebar"
    >
      <div class="flex items-center gap-1 px-2 py-1.5">
        <div class="relative flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input v-model="query" type="search" leading="icon" autocomplete="off" :placeholder="t('routines.search')" :aria-label="t('routines.searchAria')" />
        </div>
        <Button
          size="icon"
          variant="ghost"
          class="size-7"
          :aria-label="t('routines.refresh')"
          :title="t('routines.refresh')"
          @click="manualRefresh"
        >
          <RefreshCw :class="refreshing ? 'animate-spin' : ''" />
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <button
          v-for="row in rows"
          :key="row.key"
          type="button"
          class="flex h-8 w-full items-center gap-2 rounded-md pe-2 text-left text-ui hover:bg-muted"
          :class="[row.depth ? 'ps-6' : 'ps-2', row.key === selected ? 'bg-muted' : '']"
          :title="row.hint"
          :aria-current="row.key === selected ? 'true' : undefined"
          @click="onPick(row.key, 'select')"
        >
          <component
            :is="row.branch === 'open' ? ChevronDown : ChevronRight"
            v-if="row.branch"
            class="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span
            v-if="row.status?.dot"
            class="size-2 shrink-0 rounded-full"
            :class="[dotClass(row), row.status.pulse ? 'animate-pulse' : '']"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate" :class="row.depth ? '' : 'font-medium'">{{ row.label }}</span>
          <TriangleAlert v-if="row.mark" class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <span v-else-if="row.count !== undefined || row.meta" class="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {{ row.count ?? row.meta }}
          </span>
        </button>
        <p v-if="!rows.length" class="px-2 py-3 text-ui text-muted-foreground">{{ query ? t('routines.noMatch', { q: query }) : t('routines.empty') }}</p>
      </div>
    </nav>

    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        <p v-if="!loaded && !status" class="text-ui text-muted-foreground">{{ t('routines.loading') }}</p>

        <div v-else-if="loadError && !status" class="flex items-center gap-2 text-ui text-destructive">
          <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1">{{ t('routines.loadFailed', { reason: loadError }) }}</span>
          <Button size="sm" variant="outline" @click="manualRefresh">{{ t('routines.retry') }}</Button>
        </div>

        <template v-else-if="status">
          <p v-if="!status.enabled" class="flex items-center gap-2 text-ui text-warning">
            <Pause class="size-3.5 shrink-0" aria-hidden="true" />{{ t('routines.managerOff') }}
          </p>
          <p v-if="status.store?.error" class="flex items-center gap-2 text-ui text-warning">
            <CloudOff class="size-3.5 shrink-0" aria-hidden="true" />{{ t('routines.storeError', { reason: status.store.error }) }}
          </p>

          <RoutineProposalPage v-if="selectedProposal" :proposal="selectedProposal" :act="act" />

          <RoutineDetail
            v-else-if="selectedRoutine"
            :routine="selectedRoutine"
            :now="now"
            :enabled="status.enabled"
            :store="!!status.store?.repo"
            :act="act"
          />

          <p v-else-if="selected" class="text-ui text-muted-foreground">{{ t('routines.missingRoutine') }}</p>

          <p v-else-if="!status.routines.length && !status.proposals.length" class="flex items-center gap-2 text-ui text-muted-foreground">
            <CalendarClock class="size-3.5 shrink-0" aria-hidden="true" />{{ t('routines.empty') }}
          </p>

          <p v-else class="flex items-center gap-2 text-ui text-muted-foreground">
            <ListChecks class="size-3.5 shrink-0" aria-hidden="true" />{{ t('routines.pickOne') }}
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// The Routines tab (App.vue): every routine of Desk's routine manager, in folders in Desk's one sidebar (useDeskSidebar),
// and one page for the one picked. The data is Desk's own GET/POST /api/routines (lib/routines-api.ts). It is read every
// 20 s while the tab is on screen, every 3 s while a routine runs or an action is in flight (visibleInterval rests while
// the page is hidden). The rows are lib/routine-sidebar.ts; the page is components/routines/RoutineDetail.vue.
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CalendarClock, ChevronDown, ChevronRight, CloudOff, ListChecks, Pause, RefreshCw, Search, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { EmbedTone, SidebarModel, SidebarRow } from '@desk/shared/hydra-embed'
import type { Routine, RoutineProposal, RoutinesRequest, RoutinesStatus } from '@desk/shared/routines'
import { EMBEDDED, routinesAsk, type SidebarEvent, useDeskSidebar } from '@/lib/desk-embed'
import { getRoutines, postRoutines } from '@/lib/routines-api'
import { reconcileList } from '@/lib/reconcile'
import { routineSidebarRows } from '@/lib/routine-sidebar'
import { visibleInterval } from '@/lib/visible-poll'
import RoutineDetail from './RoutineDetail.vue'
import RoutineProposalPage from './RoutineProposal.vue'

const { t } = useI18n()

const status = shallowRef<RoutinesStatus | null>(null)
const loadError = ref<string | null>(null)
const loaded = ref(false)
const refreshing = ref(false)
/** Actions in flight: while one is, the page reads every 3 s. */
const inFlight = ref(0)
const now = ref(Date.now())
const query = ref('')
/** The row picked: 'r:<id>' for a routine, 'p:<id>' for a proposal. */
const selected = ref<string | null>(null)

// Folders open or closed, kept across reloads (HSwarm's tree does the same). A folder not in the map is open.
const FOLDERS_KEY = 'routines.tab.folders'
function loadOpen(): Record<string, boolean> {
  try {
    const v = localStorage.getItem(FOLDERS_KEY)
    return v == null ? {} : (JSON.parse(v) as Record<string, boolean>)
  } catch {
    return {}
  }
}
const open = ref<Record<string, boolean>>(loadOpen())
function toggleFolder(key: string) {
  open.value = { ...open.value, [key]: open.value[key] === false }
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(open.value))
  } catch {
    // Storage blocked or full: the folders still fold, they just forget it.
  }
}

async function refresh(fresh = false) {
  try {
    status.value = await getRoutines(fresh)
    loadError.value = null
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loaded.value = true
    now.value = Date.now()
  }
}
async function manualRefresh() {
  refreshing.value = true
  await refresh(true)
  refreshing.value = false
}

/** One action (POST): the answer is the whole status again. Resolves with the refusal's reason, or null when it went through. */
async function act(req: RoutinesRequest): Promise<string | null> {
  inFlight.value++
  try {
    status.value = await postRoutines(req)
    now.value = Date.now()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  } finally {
    inFlight.value--
  }
}

// The poll: 3 s while something runs or an action is in flight, else 20 s. Restarted when that changes.
const fast = computed(() => inFlight.value > 0 || (status.value?.routines.some((r) => r.state === 'running') ?? false))
let stopPoll: (() => void) | null = null
function startPoll(ms: number) {
  stopPoll?.()
  stopPoll = visibleInterval(() => void refresh(), ms)
}
// App.vue keeps each tab alive (KeepAlive), so the poll follows the tab on screen: it runs from activation
// until deactivation, and a view kept behind another tab reads nothing.
watch(fast, (on) => {
  if (stopPoll) startPoll(on ? 3000 : 20000)
})
onActivated(() => {
  void refresh()
  startPoll(fast.value ? 3000 : 20000)
})
onDeactivated(() => {
  stopPoll?.()
  stopPoll = null
})
onBeforeUnmount(() => stopPoll?.())

const selectedRoutine = computed<Routine | null>(() => {
  if (!selected.value?.startsWith('r:')) return null
  const id = selected.value.slice(2)
  return status.value?.routines.find((r) => r.id === id) ?? null
})
const selectedProposal = computed<RoutineProposal | null>(() => {
  if (!selected.value?.startsWith('p:')) return null
  const id = selected.value.slice(2)
  return status.value?.proposals.find((p) => p.id === id) ?? null
})

// Desk's sidebar asked for the tab, or for one routine on it (App.vue shows the tab; this selects the routine).
watch(
  routinesAsk,
  (ask) => {
    if (!ask) return
    routinesAsk.value = null
    if (ask.id) selected.value = `r:${ask.id}`
  },
  { flush: 'sync', immediate: true },
)

function onPick(key: string, action: string) {
  if (key.startsWith('f:')) {
    if (action !== 'star') toggleFolder(key)
    return
  }
  selected.value = key
}
function onSidebarEvent(e: SidebarEvent) {
  if (e.action === 'search') query.value = e.value
  else if (e.action === 'button') {
    if (e.id === 'refresh') void manualRefresh()
  } else if ('key' in e) onPick(e.key, e.action)
}

const labels = computed(() => ({
  awaiting: t('routines.folderAwaiting'),
  other: t('routines.folderOther'),
  needsLook: t('routines.needsLook'),
  waitingMark: t('routines.waitingMark'),
}))
// Each row keeps its identity while it says the same, so Desk is sent only what changed (HSwarm's sidebar does the same).
let sentRows: SidebarRow[] = []
const rows = computed<SidebarRow[]>(() => {
  sentRows = reconcileList(
    sentRows,
    routineSidebarRows({ status: status.value, query: query.value, open: open.value, now: now.value, labels: labels.value }),
    (r) => r.key,
  )
  return sentRows
})

// Desk's sidebar tones for a row's dot (the sidebar's own words are EmbedTone). Outside Desk the same colours.
const DOT: Record<EmbedTone, string> = {
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground',
  accent: 'bg-primary',
}
function dotClass(row: SidebarRow): string {
  const dot = row.status?.dot
  if (!dot) return ''
  return dot === 'hollow' ? 'border border-muted-foreground bg-transparent' : DOT[dot]
}

// The top of the sidebar: a problem with the list itself (a failed read, the manager off), else nothing.
const banner = computed<SidebarModel['banner']>(() => {
  if (loadError.value && !status.value) return { text: t('routines.loadFailed', { reason: loadError.value }), tone: 'danger', icon: 'alert' }
  if (status.value && !status.value.enabled) return { text: t('routines.managerOff'), tone: 'warning', icon: 'pause' }
  return undefined
})
const model = computed<SidebarModel>(() => ({
  view: 'routines',
  title: t('routines.title'),
  icon: 'clock',
  count: status.value?.routines.length,
  buttons: [{ id: 'refresh', icon: 'refresh', label: t('routines.refresh'), spin: refreshing.value }],
  banner: banner.value,
  search: { value: query.value, placeholder: t('routines.search'), label: t('routines.searchAria') },
  sections: [{ key: 'routines', rows: rows.value }],
  selected: selected.value,
  empty: query.value ? t('routines.noMatch', { q: query.value }) : t('routines.empty'),
  loading: !loaded.value,
}))
useDeskSidebar('routines', () => model.value, onSidebarEvent)
</script>

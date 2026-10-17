<template>
  <!-- Contract
    Core: 1 at first glance he knows what this is and what to do first: the overview says what needs him, and a failed or
      broken routine's header says its one reason, its pill the only red. 2 keep what he picked: the Settings > Managers
      words, Run now, the on/off switch, Edit, Mode, Move to central. 3 progressive disclosure: the overview first, then
      one page; the campaigns and the history under a routine, Details one tap deeper. 4 only a problem wears red or amber.
    Layout system: Desk's one sidebar (useDeskSidebar) or, standalone, this view's own column: an Overview row, then the
      Managers group and the Routines group, each labelled and counted. One page on the right. Rows 32px, thin dividers.
    Keys: overview, m:babysitter, m:orchestrator, m:instances, m:routines, r:<routine id>, p:<proposal id>.
    Scroll: the list and the page each scroll on their own.
    Convention: text sizes text-ui, text-2xs, text-3xs; weights 400 and 500; sentence case.
    Theme: the hydra kit theme (its tokens; never raw hex).
  -->
  <div class="flex h-full min-h-0 flex-col">
    <!-- Under 900px the standalone column is a drawer, opened from this bar (HSwarm's tree does the same). -->
    <div v-if="!EMBEDDED" ref="barEl" class="flex items-center gap-2 border-b border-border px-2 py-1 min-[900px]:hidden">
      <Button size="icon" variant="ghost" class="size-7" :aria-label="t('tools.nav.open')" :aria-expanded="navOpen" @click="openNav">
        <Menu class="size-4" />
      </Button>
      <span class="truncate text-ui text-muted-foreground">{{ t('tools.title') }}</span>
    </div>
    <div class="relative flex min-h-0 flex-1 flex-row">
      <div v-if="navOpen && !EMBEDDED" class="fixed inset-0 z-20 bg-black/40 min-[900px]:hidden" aria-hidden="true" @click="navOpen = false" />
      <!-- Outside Desk this view draws Desk's sidebar's groups as its own column (inside Desk the sidebar is Desk's). -->
      <nav
        v-if="!EMBEDDED"
        ref="navEl"
        :aria-label="t('tools.title')"
        class="flex shrink-0 flex-col border-e border-border bg-sidebar max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:inset-s-0 max-[899px]:z-30 max-[899px]:w-[min(86vw,340px)] max-[899px]:transition-transform min-[900px]:w-72"
        :class="navOpen ? '' : 'max-[899px]:-translate-x-full max-[899px]:invisible'"
        @keydown.esc="closeNav"
      >
        <div class="flex items-center gap-1 px-2 py-1.5">
          <div class="relative flex-1">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input v-model="query" type="search" leading="icon" autocomplete="off" :placeholder="t('tools.search')" :aria-label="t('tools.searchAria')" />
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
          <Button size="icon" variant="ghost" class="size-7 shrink-0 min-[900px]:hidden" :aria-label="t('tools.nav.close')" @click="closeNav">
            <X class="size-4" />
          </Button>
        </div>
        <div ref="treeEl" role="tree" :aria-label="t('tools.title')" class="min-h-0 flex-1 overflow-y-auto px-1 pb-2" @keydown="onTreeKey">
          <div v-for="sec in model.sections" :key="sec.key" role="group" :aria-label="sec.label || undefined">
            <p v-if="sec.label" class="flex items-center gap-1 px-2 pb-1 pt-2.5 text-2xs leading-4 text-muted-foreground">
              <span class="min-w-0 flex-1 truncate">{{ sec.label }}</span>
              <span class="tabular-nums">{{ sec.count ?? sec.rows.length }}</span>
            </p>
            <button
              v-for="row in sec.rows"
              :key="row.key"
              type="button"
              role="treeitem"
              class="flex h-8 w-full items-center gap-2 rounded-md pe-2 text-left text-ui hover:bg-muted"
              :class="[row.depth ? 'ps-6' : 'ps-2', row.key === selected ? 'bg-muted' : '']"
              :tabindex="row.key === tabStop ? 0 : -1"
              :aria-level="(row.depth ?? 0) + 1"
              :aria-expanded="row.branch ? row.branch === 'open' : undefined"
              :aria-selected="row.key === selected"
              :title="row.hint"
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
          </div>
          <p v-if="!model.sections.length" class="px-2 py-3 text-ui text-muted-foreground">{{ query ? t('routines.noMatch', { q: query }) : t('routines.empty') }}</p>
        </div>
      </nav>

      <div class="min-w-0 flex-1 overflow-y-auto">
        <div ref="pageEl" class="mx-auto flex max-w-3xl flex-col gap-4 p-4">
          <ToolsOverview
            v-if="selected === 'overview'"
            :babysitter="tools.babysitter"
            :orchestrator="tools.orchestrator"
            :instance-manager="tools.instanceManager"
            :routines="status"
            :now="now"
            :loading="!loaded || tools.available === null"
            :error="loadError ?? tools.error"
            @select="select"
          />
          <BabysitterPage v-else-if="selected === 'm:babysitter'" :tools="tools" />
          <OrchestratorPage v-else-if="selected === 'm:orchestrator'" :tools="tools" />
          <InstanceManagerPage v-else-if="selected === 'm:instances'" :status="tools.instanceManager" :now="now" />

          <div v-else-if="!status && loadError" class="flex items-center gap-2 text-ui text-destructive">
            <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1">{{ t('routines.loadFailed', { reason: loadError }) }}</span>
            <Button size="sm" variant="outline" @click="manualRefresh">{{ t('routines.retry') }}</Button>
          </div>
          <!-- The Routine manager's page opens while the first read is still on its way (it says "not read yet"). -->
          <RoutineManagerPage v-else-if="selected === 'm:routines'" :routines="status" :now="now" @select="select" />
          <p v-else-if="!status" class="text-ui text-muted-foreground">{{ t('routines.loading') }}</p>

          <RoutineProposalPage v-else-if="selectedProposal" :proposal="selectedProposal" :act="act" />
          <RoutineDetail
            v-else-if="selectedRoutine"
            :routine="selectedRoutine"
            :now="now"
            :enabled="status.enabled"
            :store="!!status.store?.repo"
            :act="act"
          />
          <p v-else class="text-ui text-muted-foreground">{{ t('routines.missingRoutine') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// The Tools tab (App.vue): an overview of the managers and the routines, and one page for the one picked. Desk's one
// sidebar (useDeskSidebar) lists them in two groups, Managers and Routines (lib/tools-sidebar.ts); outside Desk this
// view draws the same groups as its own column. The routines are Desk's GET/POST /api/routines (lib/routines-api.ts),
// read every 20 s while the tab is on screen and every 3 s while a routine runs or an action is in flight
// (visibleInterval rests while the page is hidden). The managers are read by useTools.
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, Menu, RefreshCw, Search, TriangleAlert, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { EmbedTone, SidebarModel, SidebarRow } from '@desk/shared/hydra-embed'
import type { Routine, RoutineProposal, RoutinesRequest, RoutinesStatus } from '@desk/shared/routines'
import { useTools } from '@/composables/useTools'
import { EMBEDDED, toolsAsk, type SidebarEvent, useDeskSidebar } from '@/lib/desk-embed'
import { getRoutines, postRoutines } from '@/lib/routines-api'
import { reconcileList } from '@/lib/reconcile'
import { routineSidebarRows } from '@/lib/routine-sidebar'
import { toolsSections } from '@/lib/tools-sidebar'
import { visibleInterval } from '@/lib/visible-poll'
import RoutineDetail from '@/components/routines/RoutineDetail.vue'
import RoutineProposalPage from '@/components/routines/RoutineProposal.vue'
import BabysitterPage from './BabysitterPage.vue'
import InstanceManagerPage from './InstanceManagerPage.vue'
import OrchestratorPage from './OrchestratorPage.vue'
import RoutineManagerPage from './RoutineManagerPage.vue'
import ToolsOverview from './ToolsOverview.vue'

const { t } = useI18n()

// On while the tab is on screen (onActivated / onDeactivated below): useTools polls the managers only then.
const active = ref(false)
const tools = useTools(active)

const status = shallowRef<RoutinesStatus | null>(null)
const loadError = ref<string | null>(null)
const loaded = ref(false)
const refreshing = ref(false)
/** Actions in flight: while one is, the page reads every 3 s. */
const inFlight = ref(0)
const now = ref(Date.now())
const query = ref('')
/** The page on screen: 'overview' or a sidebar key (m:…, r:<id> for a routine, p:<id> for a proposal). */
const selected = ref('overview')
const pageEl = ref<HTMLElement | null>(null)
const navEl = ref<HTMLElement | null>(null)
const barEl = ref<HTMLElement | null>(null)

// Under 900px the standalone column is a drawer: the bar's button opens it with focus on the row holding the tab stop;
// a pick, Esc, its close button or a tap outside closes it, and Esc or the close button give focus back to the bar.
const navOpen = ref(false)
async function openNav() {
  navOpen.value = true
  await nextTick()
  navEl.value?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus()
}
function closeNav() {
  if (!navOpen.value) return
  navOpen.value = false
  barEl.value?.querySelector<HTMLElement>('button')?.focus()
}

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
  await Promise.all([refresh(true), tools.refresh()])
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
// App.vue keeps each tab alive (KeepAlive), so the polls follow the tab on screen: they run from activation until
// deactivation, and a view kept behind another tab reads nothing.
watch(fast, (on) => {
  if (stopPoll) startPoll(on ? 3000 : 20000)
})
onActivated(() => {
  active.value = true
  void refresh()
  startPoll(fast.value ? 3000 : 20000)
})
onDeactivated(() => {
  active.value = false
  stopPoll?.()
  stopPoll = null
})
onBeforeUnmount(() => stopPoll?.())

const selectedRoutine = computed<Routine | null>(() => {
  if (!selected.value.startsWith('r:')) return null
  const id = selected.value.slice(2)
  return status.value?.routines.find((r) => r.id === id) ?? null
})
const selectedProposal = computed<RoutineProposal | null>(() => {
  if (!selected.value.startsWith('p:')) return null
  const id = selected.value.slice(2)
  return status.value?.proposals.find((p) => p.id === id) ?? null
})

// Picks a page: the overview's tiles, the sidebar's rows and Desk's asks all come here. Once the page shows, its
// heading takes focus, so a keyboard or screen-reader user hears what they picked.
async function select(key: string) {
  selected.value = key
  navOpen.value = false
  await nextTick()
  const heading = pageEl.value?.querySelector<HTMLElement>('h1, h2, [data-page-title]')
  if (heading) {
    heading.tabIndex = -1
    heading.focus()
  }
}

// Desk's Settings > Managers asked for the Tools tab, or for one of its pages (App.vue shows the tab; this selects it).
watch(
  toolsAsk,
  (ask) => {
    if (!ask) return
    toolsAsk.value = null
    void select(ask.key ?? 'overview')
  },
  { flush: 'sync', immediate: true },
)

function onPick(key: string, action: string) {
  if (key.startsWith('f:')) {
    if (action !== 'star') toggleFolder(key)
    return
  }
  void select(key)
}
function onSidebarEvent(e: SidebarEvent) {
  if (e.action === 'search') query.value = e.value
  else if (e.action === 'button') {
    if (e.id === 'refresh') void manualRefresh()
  } else if ('key' in e) onPick(e.key, e.action)
}

// HSwarm's tree keys, for the standalone column: the arrows move between the rows, Home and End go to the ends.
function onTreeKey(e: KeyboardEvent) {
  const items = [...(navEl.value?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
  const at = items.indexOf(e.target as HTMLElement)
  if (at < 0) return
  const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }
  const to = moves[e.key]
  if (to === undefined) return
  e.preventDefault()
  items[Math.min(Math.max(to, 0), items.length - 1)]?.focus()
}

const labels = computed(() => ({
  awaiting: t('routines.folderAwaiting'),
  other: t('routines.folderOther'),
  needsLook: t('routines.needsLook'),
  waitingMark: t('routines.waitingMark'),
}))
const sidebarLabels = computed(() => ({
  overview: t('tools.sections.overview'),
  managers: t('tools.sections.managers'),
  routines: t('tools.sections.routines'),
  babysitter: t('tools.managers.babysitter.title'),
  orchestrator: t('tools.managers.orchestrator.title'),
  instanceManager: t('tools.managers.instances.title'),
  routineManager: t('tools.managers.routines.title'),
  on: t('tools.managers.on'),
  off: t('tools.managers.off'),
  armed: t('tools.managers.orchestrator.armed'),
  shadow: t('tools.managers.orchestrator.shadow'),
  stopped: (n: number) => t('tools.managers.babysitter.stoppedCount', { n }),
  waiting: (n: number) => t('tools.managers.routines.waitingCount', { n }),
}))
// Each row keeps its identity while it says the same, so Desk is sent only what changed (HSwarm's sidebar does the same).
let sentRows: SidebarRow[] = []
const routineRows = computed<SidebarRow[]>(() => {
  sentRows = reconcileList(
    sentRows,
    routineSidebarRows({ status: status.value, query: query.value, open: open.value, now: now.value, labels: labels.value }),
    (r) => r.key,
  )
  return sentRows
})
const sections = computed(() =>
  toolsSections({
    babysitter: tools.babysitter,
    orchestrator: tools.orchestrator,
    instanceManager: tools.instanceManager,
    routines: status.value,
    routineRows: routineRows.value,
    query: query.value,
    labels: sidebarLabels.value,
  }),
)

// The standalone column's one Tab stop: the picked row, or the first row while a search hides it (else Tab could not
// get back into the list).
const tabStop = computed(() => {
  const keys = sections.value.flatMap((s) => s.rows.map((r) => r.key))
  return keys.includes(selected.value) ? selected.value : keys[0]
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

// The top of the sidebar: a problem with the list itself (a failed read, the routine manager off), else nothing.
const banner = computed<SidebarModel['banner']>(() => {
  if (loadError.value && !status.value) return { text: t('routines.loadFailed', { reason: loadError.value }), tone: 'danger', icon: 'alert' }
  if (status.value && !status.value.enabled) return { text: t('routines.managerOff'), tone: 'warning', icon: 'pause' }
  return undefined
})
const model = computed<SidebarModel>(() => ({
  view: 'tools',
  title: t('tools.title'),
  icon: 'wrench',
  buttons: [{ id: 'refresh', icon: 'refresh', label: t('routines.refresh'), spin: refreshing.value }],
  banner: banner.value,
  search: { value: query.value, placeholder: t('tools.search'), label: t('tools.searchAria') },
  sections: sections.value,
  selected: selected.value,
  empty: query.value ? t('routines.noMatch', { q: query.value }) : t('routines.empty'),
  loading: !loaded.value,
}))
useDeskSidebar('tools', () => model.value, onSidebarEvent)
</script>

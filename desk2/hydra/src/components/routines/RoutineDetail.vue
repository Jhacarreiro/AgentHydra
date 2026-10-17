<script setup lang="ts">
// One routine's page, one template for every kind: a sticky header (name, state, the schedule in words and the next run,
// and the actions), the key facts as tiles, the campaigns it works for, the run history, and Details one tap deeper.
// The numbers come from GET /api/routines/:id/details and /campaigns; the actions go through `act` (the view's POST).
import { computed, type Component, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  EllipsisVertical,
  Hourglass,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  SlidersHorizontal,
  TriangleAlert,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import HSwarmJobs from '@/components/hswarm/HSwarmJobs.vue'
import { hswarmNodeAsk } from '@/lib/app-view'
import { deskSwarmAsk, deskWorkerAsk, openInDesk } from '@/lib/desk-embed'
import { useHswarmApi } from '@/lib/hswarm-api'
import { getRoutineCampaigns, getRoutineDetails } from '@/lib/routines-api'
import {
  durationText,
  exactTime,
  localZone,
  nextRunText,
  percentText,
  relativeTime,
  scheduleWords,
  stateView,
  type RoutineTone,
} from '@/lib/routine-words'
import type {
  Routine,
  RoutineCampaigns as CampaignsData,
  RoutineDetails,
  RoutineDetailsStats,
  RoutineOutcome,
  RoutineRun,
  RoutinesRequest,
} from '@desk/shared/routines'
import RoutineCampaigns from './RoutineCampaigns.vue'
import RoutineEditForm from './RoutineEditForm.vue'
import RoutineHistory from './RoutineHistory.vue'

// The work this routine started (its CliMayte workers and its HSwarm jobs) is HSwarm's to show: a worker or a
// wave opens on the HSwarm tab's CliMayte node (App.vue switches the tab for either ask).
const hswarmState = useHswarmApi().state
function openWork(id: string, wave: boolean) {
  if (wave) {
    hswarmNodeAsk.value = 'climayte/waves'
    deskSwarmAsk.value = {}
  } else deskWorkerAsk.value = { id }
}

const props = defineProps<{
  routine: Routine
  now: number
  /** The routine manager is on. */
  enabled: boolean
  /** A central store is set up, so a routine on this computer can move to it. */
  store: boolean
  act: (req: RoutinesRequest) => Promise<string | null>
}>()
const { t } = useI18n()
const zone = localZone()

const PILL: Record<RoutineTone, string> = {
  success: 'bg-success/15 text-success',
  info: 'bg-info/15 text-info',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}
const view = computed(() => stateView(props.routine))
const pillIcon = computed<Component>(() => {
  if (props.routine.state === 'running') return LoaderCircle
  const tone = view.value.tone
  if (tone === 'danger') return TriangleAlert
  if (tone === 'warning') return Hourglass
  if (tone === 'info') return Clock
  if (tone === 'success') return CircleCheck
  return Pause
})
const schedule = computed(() => scheduleWords(props.routine, props.routine.timeZone ?? zone))
const nextText = computed(() => nextRunText(props.routine, props.now))
const outcomeIcon = (o: RoutineOutcome): Component => (o === 'ok' ? CircleCheck : o === 'busy' ? Clock : CircleX)

// The pieces the server reads: the details (whole history) and the campaigns' ledgers, each kept by the routine it is for.
const details = shallowRef<RoutineDetails | null>(null)
const detailsError = ref<string | null>(null)
const runs = shallowRef<RoutineRun[]>([])
const nextBefore = ref<number | null>(null)
const morePending = ref(false)
const campaigns = shallowRef<CampaignsData | null>(null)
const campaignsError = ref<string | null>(null)
const stats = computed<RoutineDetailsStats | null>(() => details.value?.stats ?? null)

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function loadFirst() {
  const id = props.routine.id
  try {
    const d = await getRoutineDetails(id, { limit: 50 })
    if (id !== props.routine.id) return
    details.value = d
    runs.value = d.runs
    nextBefore.value = d.nextBefore
    detailsError.value = null
  } catch (e) {
    if (id === props.routine.id) detailsError.value = reason(e)
  }
}

async function loadMore() {
  const id = props.routine.id
  const before = nextBefore.value
  if (before === null || morePending.value) return
  morePending.value = true
  try {
    const d = await getRoutineDetails(id, { limit: 50, before })
    if (id !== props.routine.id) return
    runs.value = [...runs.value, ...d.runs]
    nextBefore.value = d.nextBefore
  } catch (e) {
    if (id === props.routine.id) detailsError.value = reason(e)
  } finally {
    morePending.value = false
  }
}

async function loadCampaigns() {
  const id = props.routine.id
  if (!props.routine.campaigns?.length) {
    campaigns.value = null
    campaignsError.value = null
    return
  }
  try {
    const c = await getRoutineCampaigns(id)
    if (id !== props.routine.id) return
    campaigns.value = c
    campaignsError.value = null
  } catch (e) {
    if (id === props.routine.id) campaignsError.value = reason(e)
  }
}

const editing = ref(false)
const showDetails = ref(false)
const pending = ref<string | null>(null)
const actionError = ref<string | null>(null)

// Another routine on screen: its own history, and the form closed. A finished run, a new run count or a changed set
// of campaigns reads the numbers again (the key is a string, so a poll that changes nothing does not re-read).
watch(
  () => props.routine.id,
  () => {
    editing.value = false
    actionError.value = null
    void loadFirst()
    void loadCampaigns()
  },
  { immediate: true },
)
watch(
  () => `${props.routine.lastRunAt}|${props.routine.runsTotal}|${(props.routine.campaigns ?? []).join(',')}`,
  () => {
    void loadFirst()
    void loadCampaigns()
  },
)

async function doAction(key: string, req: RoutinesRequest) {
  pending.value = key
  actionError.value = await props.act(req)
  pending.value = null
}

/** Why Run now is off, as the tooltip says it; null when it can run. */
const runWhy = computed<string | null>(() => {
  const r = props.routine
  if (!props.enabled) return t('routines.reasonNoManager')
  if (r.state === 'running') return t('routines.reasonRunning')
  if (r.state === 'broken') return t('routines.reasonBroken', { reason: r.reason })
  if (r.state === 'elsewhere') return t('routines.reasonElsewhere')
  if (r.state === 'ended') return t('routines.reasonEnded')
  if (r.state === 'off') return t('routines.reasonOff')
  return null
})
const isPaused = computed(() => props.routine.paused || props.routine.state === 'paused')

// The header's facts about the last run and the tiles.
const lastRun = computed<RoutineRun | null>(() => props.routine.runs[0] ?? null)
const lastAt = computed<number | null>(() => lastRun.value?.endedAt ?? props.routine.lastRunAt)
// Core rule 1: a broken routine or a failed last run leads with its one fix, in danger colour.
const leadProblem = computed<string | null>(() => {
  const r = props.routine
  if (r.state === 'broken') return t('routines.reasonBroken', { reason: r.reason })
  const last = lastRun.value
  if (last && last.outcome !== 'ok' && last.outcome !== 'busy' && last.lastLine) return last.lastLine
  return null
})
interface Tile {
  key: string
  label: string
  value: string
  title?: string
}
const tiles = computed<Tile[]>(() => {
  const s = stats.value
  const list: Tile[] = [
    { key: 'rate', label: t('routines.successRate'), value: percentText(s?.successRate ?? null) },
    {
      key: 'runs',
      label: t('routines.runs'),
      value: String(s?.total ?? props.routine.runsTotal ?? 0),
      title: s ? t('routines.runsLast7', { n: s.last7d }) : undefined,
    },
    { key: 'avg', label: t('routines.avgDuration'), value: durationText(s?.avgMs ?? null) },
    {
      key: 'last',
      label: t('routines.lastRun'),
      value: lastAt.value === null ? t('routines.none') : relativeTime(lastAt.value, props.now),
      title: exactTime(lastAt.value),
    },
  ]
  // A campaign's numbers are its own block (RoutineCampaigns), one per campaign: a routine may drive several.
  return list
})

// The newest run that has a chat, for 'Open last chat' (a prompt run).
const chatRun = computed(() => props.routine.runs.find((r) => r.sessionId) ?? null)
const isLocal = computed(() => props.routine.source === undefined)

// Details one tap deeper: what it runs, where, and who asked.
const detailRows = computed<{ label: string; value: string; block?: boolean }[]>(() => {
  const r = props.routine
  const rows: { label: string; value: string; block?: boolean }[] = []
  if (r.what === 'prompt' && r.prompt) rows.push({ label: t('routines.prompt'), value: r.prompt, block: true })
  if (r.what === 'run' && r.command) rows.push({ label: t('routines.command'), value: r.command.join(' '), block: true })
  if (r.statusCommand) rows.push({ label: t('routines.statusCommand'), value: r.statusCommand.join(' '), block: true })
  if (r.windowsTask) rows.push({ label: t('routines.windowsTaskPath'), value: r.windowsTask })
  rows.push({ label: t('routines.folder'), value: r.cwd ?? '-' })
  rows.push({
    label: t('routines.whereItRuns'),
    value: r.runsOn?.length ? t('routines.onRunners', { labels: r.runsOn.join(', ') }) : t('routines.thisComputer'),
  })
  rows.push({ label: t('routines.timeZone'), value: r.timeZone ?? zone })
  rows.push({ label: t('routines.askedBy'), value: r.askedBy ?? '-' })
  rows.push({ label: t('routines.approval'), value: r.source === 'central' ? t('routines.approved') : '-' })
  rows.push({ label: t('routines.timeout'), value: t('routines.timeoutValue', { n: r.timeoutMinutes ?? 0 }) })
  rows.push({ label: t('routines.untilDay'), value: r.until ?? '-' })
  rows.push({ label: t('routines.describe'), value: r.describe ? t('routines.describeYes') : t('routines.describeNo') })
  return rows
})

function copyId() {
  void navigator.clipboard?.writeText(props.routine.id)
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- Header: sticky. Name, state, the schedule in words and the next run, then the actions. -->
    <header class="sticky top-0 z-10 flex flex-col gap-2 bg-background pb-2">
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <div class="flex min-w-0 items-center gap-2">
            <h2 class="min-w-0 truncate text-ui font-medium">{{ routine.name }}</h2>
            <span class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs" :class="PILL[view.tone]">
              <component :is="pillIcon" class="size-3.5" aria-hidden="true" />{{ view.word }}
            </span>
          </div>
          <p class="truncate text-ui text-muted-foreground" :title="exactTime(routine.nextRunAt)">
            {{ schedule }} · {{ nextText }}<span v-if="routine.until"> · {{ t('routines.until', { date: routine.until }) }}</span>
          </p>
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            :disabled="runWhy !== null || pending !== null"
            :title="runWhy ?? undefined"
            @click="doAction('run', { run: routine.id })"
          >
            <Play />{{ t('routines.runNow') }}
          </Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="pending !== null"
            @click="doAction(isPaused ? 'resume' : 'pause', isPaused ? { resume: routine.id } : { pause: routine.id })"
          >
            <component :is="isPaused ? Play : Pause" />{{ isPaused ? t('routines.resume') : t('routines.pause') }}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            :aria-label="t('routines.edit')"
            :aria-pressed="editing"
            :title="t('routines.edit')"
            @click="editing = !editing"
          >
            <Pencil />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button size="icon" variant="ghost" :aria-label="t('routines.more')" :title="t('routines.more')">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem v-if="chatRun" @select="openInDesk({ session_id: chatRun.sessionId!, source: 'claude' })">
                {{ t('routines.openChat') }}
              </DropdownMenuItem>
              <DropdownMenuItem v-if="store && isLocal" @select="doAction('move', { move: routine.id })">
                {{ t('routines.moveCentral') }}
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="routine.kind !== 'windowsTask'"
                @select="doAction('describe', { edit: { id: routine.id, set: { describe: !routine.describe } } })"
              >
                {{ routine.describe ? t('routines.describeOff') : t('routines.describeOn') }}
              </DropdownMenuItem>
              <template v-if="routine.modes?.length">
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{{ t('routines.mode') }}</DropdownMenuLabel>
                <DropdownMenuItem
                  v-for="m in routine.modes"
                  :key="m"
                  :disabled="routine.mode === m"
                  @select="doAction('mode', { mode: { id: routine.id, value: m } })"
                >
                  {{ cap(m) }}
                </DropdownMenuItem>
              </template>
              <DropdownMenuSeparator />
              <DropdownMenuItem @select="copyId">
                <Copy class="size-3.5" aria-hidden="true" />{{ t('routines.copyId') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p v-if="actionError" class="text-ui text-destructive">{{ t('routines.actionFailed', { reason: actionError }) }}</p>
    </header>

    <p v-if="leadProblem" class="text-ui text-destructive">{{ leadProblem }}</p>

    <!-- Key facts: one tile shape, a small label over the value. -->
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div
        v-for="tile in tiles"
        :key="tile.key"
        class="flex h-14 flex-col justify-center rounded-md bg-muted/40 px-3"
        :title="tile.title"
      >
        <span class="text-2xs text-muted-foreground">{{ tile.label }}</span>
        <span class="flex items-center gap-1.5 text-ui font-medium tabular-nums">
          <component :is="outcomeIcon(lastRun.outcome)" v-if="tile.key === 'last' && lastRun" class="size-3.5 shrink-0" aria-hidden="true" />
          {{ tile.value }}
        </span>
      </div>
    </div>

    <p v-if="detailsError" class="text-ui text-destructive">{{ t('routines.loadFailed', { reason: detailsError }) }}</p>

    <RoutineEditForm v-if="editing" :routine="routine" :act="act" @done="editing = false" @cancel="editing = false" />

    <RoutineCampaigns v-if="routine.campaigns?.length" :data="campaigns" :error="campaignsError" :now="now" />

    <RoutineHistory
      :runs="runs"
      :stats="stats"
      :next-before="nextBefore"
      :busy="morePending"
      :now="now"
      @more="loadMore"
    />

    <!-- Work it started: the CliMayte workers in its group and the HSwarm jobs labelled with its id. -->
    <section class="flex flex-col gap-2">
      <h2 class="text-ui font-medium">{{ t('tools.managers.routine.work') }}</h2>
      <p class="text-ui text-muted-foreground">{{ t('tools.managers.routine.workNote', { id: routine.id }) }}</p>
      <HSwarmJobs v-if="hswarmState" :state="hswarmState" :routine="routine.id" @open-task="openWork" />
      <p v-else class="text-ui text-muted-foreground">{{ t('tools.managers.routine.noHswarm') }}</p>
    </section>

    <!-- Details: folded by default; what it runs, where, and who asked. -->
    <section class="flex flex-col gap-2">
      <button
        type="button"
        class="inline-flex w-fit items-center gap-1.5 rounded-md text-ui font-medium hover:text-foreground"
        :aria-expanded="showDetails"
        @click="showDetails = !showDetails"
      >
        <component :is="showDetails ? ChevronDown : ChevronRight" class="size-3.5 text-muted-foreground" aria-hidden="true" />
        <SlidersHorizontal class="size-3.5 text-muted-foreground" aria-hidden="true" />{{ t('routines.details') }}
      </button>
      <dl v-if="showDetails" class="flex flex-col gap-2 text-ui">
        <div v-for="row in detailRows" :key="row.label" class="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
          <dt class="w-32 shrink-0 text-muted-foreground">{{ row.label }}</dt>
          <dd
            class="min-w-0 flex-1 break-all"
            :class="row.block ? 'max-h-60 overflow-auto rounded-md bg-muted/40 p-2 font-mono whitespace-pre-wrap' : ''"
          >
            {{ row.value }}
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>

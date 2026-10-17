<script setup lang="ts">
// The Tools tab's landing page: one tile per manager (Babysitter, Orchestrator, Instance manager, Routine manager) and one
// tile per routine, in folders in the sidebar's order. A tile says its state in words and colour, its key number, and when
// the manager last looked and when it looks next. A tile emits the key of the page it opens. Each routine card has a small
// switch that pauses or resumes that routine (owner, 2026-10-17: "a very small toggle ... inconspicuous"), a sibling of the
// card's button, never inside it; a refusal shows on the card in the destructive colour, and on the switch's title.
import type { BabysitterStatus } from '@desk/shared/babysitter'
import type { InstanceManagerStatus } from '@desk/shared/instance-manager'
import type { OrchestratorPlan } from '@desk/shared/orchestrator'
import type { Routine, RoutineOutcome, RoutineProposal, RoutinesRequest, RoutinesStatus } from '@desk/shared/routines'
import { CircleCheck, CircleX, Clock } from '@lucide/vue'
import { type Component, computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Switch } from '@/components/ui/switch'
import { folderName } from '@/lib/routine-sidebar'
import { isRoutinePaused, routineSwitchRequest } from '@/lib/routine-switch'
import { type RoutineTone, dotTone, exactTime, nextRunText, relativeTime, stateView } from '@/lib/routine-words'
import { type ManagerDot, babysitterDot, instanceManagerDot, managerDot } from '@/lib/managers'

const props = defineProps<{
  babysitter: BabysitterStatus | null
  orchestrator: OrchestratorPlan | null
  instanceManager: InstanceManagerStatus | null
  routines: RoutinesStatus | null
  now: number
  loading: boolean
  error: string | null
  act: (req: RoutinesRequest) => Promise<string | null>
}>()

const emit = defineEmits<{ select: [key: string] }>()

const { t, locale } = useI18n()

interface ManagerTile {
  key: string
  name: string
  dot: ManagerDot | undefined
  state: string
  attention: boolean
  number: string
  noun: string
  lines: string[]
  last: string
  lastAt: number | null
  next: string
  nextAt: number | null
  label: string
}

interface RoutineCard {
  key: string
  name: string
  label: string
  word: string
  pillClass: string
  dotClass: string
  pulse: boolean
  last: string
  lastAt: number | null
  icon: Component | null
  next: string
  number: string
  noun: string
  waiting: boolean
  /** The routine behind a routine card (null on a proposal, which has no switch). */
  routine: Routine | null
  /** On is not paused: the switch's state. */
  on: boolean
  switchLabel: string
}

// A routine needs a look when its state reads red or amber, the same test the sidebar's folder marks use.
const needsLook = (x: Routine): boolean => {
  const tone = dotTone(x.state, x.runs, x.paused).tone
  return tone === 'danger' || tone === 'warning'
}

interface Folder {
  name: string
  cards: RoutineCard[]
}

const DOT_CLASS: Record<ManagerDot | 'none', string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  off: 'bg-muted-foreground/50',
  run: 'bg-info',
  bad: 'bg-destructive',
  none: 'bg-muted-foreground/50',
}

const TEXT_CLASS: Record<ManagerDot | 'none', string> = {
  ok: 'text-success',
  warn: 'text-warning',
  off: 'text-muted-foreground',
  run: 'text-info',
  bad: 'text-destructive',
  none: 'text-muted-foreground',
}

const PILL_CLASS: Record<RoutineTone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
}

const TONE_DOT_CLASS: Record<RoutineTone, string> = {
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground/50',
}

const OUTCOME_ICON: Record<RoutineOutcome, Component> = {
  ok: CircleCheck,
  busy: Clock,
  failed: CircleX,
  'timed-out': CircleX,
  interrupted: CircleX,
}

const stateWord = (dot: ManagerDot | undefined): string => {
  if (dot === 'bad') return t('tools.overview.state.problem')
  if (dot === 'warn') return t('tools.overview.state.attention')
  if (dot === 'ok') return t('tools.overview.state.on')
  if (dot === 'off') return t('tools.overview.state.off')
  return t('tools.overview.state.notRead')
}

const lastLook = (at: number | null): string => (at === null ? t('tools.overview.noLook') : t('tools.overview.lastLook', { when: relativeTime(at, props.now) }))
// relativeTime words a past instant as 'ago' and a look under a minute away as 'just now', so both read as due.
const nextLook = (at: number | null): string => {
  if (at === null) return ''
  if (at - props.now < 60_000) return t('tools.overview.dueNow')
  return t('tools.overview.nextLook', { when: relativeTime(at, props.now) })
}

function managerTile(key: string, name: string, dot: ManagerDot | undefined, state: string, number: string, noun: string, lines: string[], last: number | null, next: number | null): ManagerTile {
  const lastText = lastLook(last)
  const nextText = nextLook(next)
  return {
    key,
    name,
    dot,
    state,
    attention: dot === 'bad' || dot === 'warn',
    number,
    noun,
    lines,
    last: lastText,
    lastAt: last,
    next: nextText,
    nextAt: next,
    label: t('tools.overview.tileName', { name, state, number, noun, looks: [lastText, nextText].filter(Boolean).join(', ') }),
  }
}

const managers = computed<ManagerTile[]>(() => {
  const b = props.babysitter
  const o = props.orchestrator
  const i = props.instanceManager
  const r = props.routines

  const babysitterTile = managerTile(
    'm:babysitter',
    t('tools.overview.babysitter.name'),
    babysitterDot(b),
    stateWord(babysitterDot(b)),
    b ? String(b.stopped.length) : '-',
    t('tools.overview.babysitter.noun'),
    b?.error ? [t('tools.overview.babysitter.readError', { reason: b.error })] : [],
    b?.checkedAt ?? null,
    b?.nextCheckAt ?? null,
  )

  const armed = o?.mode === 'armed'
  const orchestratorTile = managerTile(
    'm:orchestrator',
    t('tools.overview.orchestrator.name'),
    o ? (armed ? 'ok' : 'off') : undefined,
    o ? t(armed ? 'tools.overview.state.armed' : 'tools.overview.state.shadow') : t('tools.overview.state.notRead'),
    o ? String(o.rows.length) : '-',
    t('tools.overview.orchestrator.noun'),
    o
      ? [
          t('tools.overview.orchestrator.counts', { watch: o.counts.watch ?? 0, done: o.counts.done ?? 0, leave: o.counts.leave ?? 0 }),
          t('tools.overview.orchestrator.acted', { n: o.acts.length }),
        ]
      : [],
    o?.at ?? null,
    null,
  )

  const up = i ? i.instances.filter((x) => x.running && x.signedIn && !x.dead).length : 0
  const total = i?.instances.length ?? 0
  const working = i ? i.instances.reduce((sum, x) => sum + x.working, 0) : 0
  const unfinished = i?.recoveries.filter((x) => ['waiting', 'opening', 'moving', 'watching', 'failed'].includes(x.state)).sort((x, y) => y.at - x.at)[0]
  const instanceDot = instanceManagerDot(i)
  const instanceTile = managerTile(
    'm:instances',
    t('tools.overview.instanceManager.name'),
    instanceDot,
    stateWord(instanceDot),
    i ? String(up) : '-',
    t('tools.overview.instanceManager.noun', { total }),
    [
      t('tools.overview.instanceManager.working', { n: working }),
      unfinished
        ? t('tools.overview.instanceManager.recovery', {
            state: t(`tools.instanceManager.recoveryState.${unfinished.state}`),
            from: unfinished.from.name,
            to: unfinished.to?.name ?? t('tools.instanceManager.recoveries.noTo'),
          })
        : t('tools.overview.instanceManager.noRecovery'),
    ],
    i?.checkedAt ?? null,
    i?.nextCheckAt ?? null,
  )

  const proposals = r?.proposals.length ?? 0
  const routineDotValue = r ? managerDot(r.enabled, !!r.error || !!r.store?.error) : undefined
  const routineDot: ManagerDot | undefined = routineDotValue === 'ok' && proposals ? 'warn' : routineDotValue
  const running = r?.routines.filter((x) => x.state === 'running').length ?? 0
  const paused = r?.routines.filter((x) => x.paused || x.state === 'paused').length ?? 0
  const routineTile = managerTile(
    'm:routines',
    t('tools.overview.routineManager.name'),
    routineDot,
    stateWord(routineDot),
    r ? String(r.routines.length) : '-',
    t('tools.overview.routineManager.noun'),
    r
      ? [
          t('tools.overview.routineManager.counts', { running, paused }),
          ...(proposals ? [t('tools.overview.routineManager.waiting', { n: proposals })] : []),
          ...(r.error ? [t('tools.overview.routineManager.readError', { reason: r.error })] : []),
        ]
      : [],
    r?.checkedAt ?? null,
    r?.nextCheckAt ?? null,
  )

  return [babysitterTile, orchestratorTile, instanceTile, routineTile]
})

function routineCard(x: Routine): RoutineCard {
  const view = stateView(x)
  const dot = dotTone(x.state, x.runs, x.paused)
  const totals = x.totals ? Object.entries(x.totals)[0] : undefined
  let number = ''
  let noun = ''
  if (totals) {
    number = String(totals[1])
    noun = totals[0]
  } else if (x.runsTotal !== undefined) {
    number = String(x.runsTotal)
    noun = t('tools.overview.routine.runs')
  } else if (x.runs.length) {
    number = String(x.runs.filter((run) => run.outcome === 'ok').length)
    noun = t('tools.overview.routine.okOfLast', { n: x.runs.length })
  }
  const lastText = x.lastRunAt === null ? t('tools.overview.routine.noRun') : relativeTime(x.lastRunAt, props.now)
  const next = nextRunText(x, props.now)
  const on = !isRoutinePaused(x)
  return {
    routine: x,
    on,
    switchLabel: on ? t('tools.overview.routine.pauseSwitch', { name: x.name }) : t('tools.overview.routine.resumeSwitch', { name: x.name }),
    key: `r:${x.id}`,
    name: x.name,
    label: t('tools.overview.routine.name', { name: x.name, state: view.word, last: lastText, next }),
    word: view.word,
    pillClass: PILL_CLASS[view.tone],
    dotClass: dot.hollow ? 'border border-muted-foreground' : TONE_DOT_CLASS[dot.tone],
    pulse: dot.pulse,
    last: lastText,
    lastAt: x.lastRunAt,
    icon: x.runs[0] ? OUTCOME_ICON[x.runs[0].outcome] : null,
    next,
    number,
    noun,
    waiting: false,
  }
}

function proposalCard(p: RoutineProposal): RoutineCard {
  const word = t('tools.overview.routine.waiting')
  return {
    routine: null,
    on: false,
    switchLabel: '',
    key: `p:${p.id}`,
    name: p.name,
    label: t('tools.overview.routine.proposalName', { name: p.name, state: word }),
    word,
    pillClass: PILL_CLASS.warning,
    dotClass: TONE_DOT_CLASS.warning,
    pulse: false,
    last: '',
    lastAt: null,
    icon: null,
    next: '',
    number: '',
    noun: '',
    waiting: true,
  }
}

// One flip in flight per routine: its switch is disabled meanwhile. A refusal stays on the card until the next flip.
const busy = ref<Record<string, boolean>>({})
const refusals = ref<Record<string, string>>({})
async function flip(card: RoutineCard) {
  if (!card.routine || busy.value[card.key]) return
  busy.value[card.key] = true
  const reason = await props.act(routineSwitchRequest(card.routine))
  delete busy.value[card.key]
  if (reason) refusals.value[card.key] = reason
  else delete refusals.value[card.key]
}

const awaitingName = computed(() => t('tools.overview.folders.awaiting'))
const otherName = computed(() => t('tools.overview.folders.other'))

// Awaiting approval first, the named folders by name, Other last: the sidebar's order (lib/routine-sidebar.ts).
const folders = computed<Folder[]>(() => {
  const s = props.routines
  if (!s) return []
  const byFolder = new Map<string, RoutineCard[]>()
  const add = (name: string, card: RoutineCard) => byFolder.set(name, [...(byFolder.get(name) ?? []), card])
  for (const p of s.proposals) add(awaitingName.value, proposalCard(p))
  for (const r of s.routines) add(folderName(r.group, otherName.value), routineCard(r))
  const rank = (name: string) => (name === awaitingName.value ? 0 : name === otherName.value ? 2 : 1)
  return [...byFolder.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, cards]) => ({ name, cards: cards.sort((x, y) => x.name.localeCompare(y.name)) }))
})

const summary = computed(() => {
  const s = props.routines
  if (!s) return ''
  const running = s.routines.filter((x) => x.state === 'running').length
  const look = s.routines.filter(needsLook).length
  return t('tools.overview.summary', { total: s.routines.length, running, look, waiting: s.proposals.length })
})

const attentionText = computed(() => {
  const items = managers.value.filter((m) => m.attention).map((m) => t('tools.overview.attentionItem', { name: m.name, state: m.state }))
  const looks = props.routines?.routines.filter(needsLook).length ?? 0
  if (looks) items.push(t('tools.overview.attentionRoutines', { n: looks }, looks))
  if (!items.length) return ''
  const list = new Intl.ListFormat(locale.value, { style: 'long', type: 'conjunction' }).format(items)
  return t('tools.overview.attention', { items: list })
})

const attentionTone = computed(() => (managers.value.some((m) => m.dot === 'bad') ? 'text-destructive' : 'text-warning'))
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-4 p-4">
    <header class="flex flex-col gap-1">
      <h1 tabindex="-1" class="text-ui font-medium focus-visible:outline-2 focus-visible:outline-primary">{{ t('tools.overview.title') }}</h1>
      <p class="text-ui text-muted-foreground">{{ t('tools.overview.lead') }}</p>
    </header>

    <p role="status" aria-live="polite" class="text-ui" :class="attentionTone"><template v-if="attentionText">{{ attentionText }}</template></p>
    <p v-if="error" class="text-ui text-destructive">{{ t('tools.overview.loadFailed', { reason: error }) }}</p>

    <section aria-labelledby="tools-overview-managers" class="flex flex-col gap-2">
      <h2 id="tools-overview-managers" class="text-ui font-medium">{{ t('tools.overview.managers') }}</h2>
      <ul role="list" class="grid gap-2 sm:grid-cols-2" :aria-busy="loading ? 'true' : undefined">
        <li v-for="tile in managers" :key="tile.key">
          <button
            type="button"
            class="flex h-full w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left focus-visible:outline-2 focus-visible:outline-primary"
            :aria-label="tile.label"
            @click="emit('select', tile.key)"
          >
            <span class="flex items-center gap-2 text-ui font-medium">
              <span aria-hidden="true" class="size-2 shrink-0 rounded-full" :class="DOT_CLASS[tile.dot ?? 'none']"></span>
              <span class="min-w-0 flex-1 truncate">{{ tile.name }}</span>
              <span class="text-2xs" :class="TEXT_CLASS[tile.dot ?? 'none']">{{ tile.state }}</span>
            </span>
            <span class="flex items-baseline gap-1.5">
              <span class="text-2xl font-semibold tabular-nums">{{ tile.number }}</span>
              <span class="text-ui text-muted-foreground">{{ tile.noun }}</span>
            </span>
            <span v-for="line in tile.lines" :key="line" class="text-2xs text-muted-foreground">{{ line }}</span>
            <span class="mt-auto flex flex-wrap gap-x-2 text-3xs text-muted-foreground">
              <span :title="exactTime(tile.lastAt)">{{ tile.last }}</span>
              <span v-if="tile.next" :title="exactTime(tile.nextAt)">{{ tile.next }}</span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <section aria-labelledby="tools-overview-routines" class="flex flex-col gap-3">
      <h2 id="tools-overview-routines" class="text-ui font-medium">{{ t('tools.overview.routines') }}</h2>
      <p v-if="loading && !routines" class="text-ui text-muted-foreground">{{ t('tools.overview.loading') }}</p>
      <p v-else-if="routines" class="text-2xs text-muted-foreground">{{ summary }}</p>
      <p v-if="routines && !routines.routines.length && !routines.proposals.length" class="text-ui text-muted-foreground">
        {{ t('tools.overview.noRoutines') }}
      </p>

      <div v-for="folder in folders" :key="folder.name" class="flex flex-col gap-2">
        <h3 class="flex items-baseline gap-2 text-ui font-medium">
          {{ folder.name }}
          <span class="text-2xs text-muted-foreground tabular-nums">{{ folder.cards.length }}</span>
        </h3>
        <ul role="list" class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" :aria-busy="loading ? 'true' : undefined">
          <li v-for="card in folder.cards" :key="card.key" class="relative">
            <button
              type="button"
              class="flex h-full w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left focus-visible:outline-2 focus-visible:outline-primary"
              :aria-label="card.label"
              @click="emit('select', card.key)"
            >
              <!-- The title line keeps clear of the switch in the corner (the switch sits over the card, not inside it). -->
              <span class="flex items-center gap-2" :class="card.routine && 'pe-7'">
                <span aria-hidden="true" class="size-2 shrink-0 rounded-full" :class="[card.dotClass, card.pulse && 'motion-safe:animate-pulse']"></span>
                <span class="min-w-0 flex-1 truncate text-ui font-medium" :title="card.name">{{ card.name }}</span>
              </span>
              <span class="text-2xs" :class="card.pillClass">{{ card.word }}</span>
              <span v-if="refusals[card.key]" class="text-2xs text-destructive">{{ refusals[card.key] }}</span>
              <template v-if="!card.waiting">
                <span v-if="card.last !== card.word" class="flex items-center gap-1 text-2xs text-muted-foreground" :title="exactTime(card.lastAt)">
                  <component :is="card.icon" v-if="card.icon" class="size-3.5 shrink-0" aria-hidden="true" />
                  {{ t('tools.overview.routine.lastRun') }}: {{ card.last }}
                </span>
                <span class="text-2xs text-muted-foreground">{{ card.next }}</span>
                <span v-if="card.number" class="flex items-baseline gap-1.5">
                  <span class="text-2xl font-semibold tabular-nums">{{ card.number }}</span>
                  <span class="text-2xs text-muted-foreground">{{ card.noun }}</span>
                </span>
              </template>
            </button>
            <Switch
              v-if="card.routine"
              size="sm"
              class="absolute end-3 top-3 opacity-60 hover:opacity-100"
              :model-value="card.on"
              :disabled="!!busy[card.key]"
              :aria-label="card.switchLabel"
              :title="refusals[card.key] ?? card.switchLabel"
              @update:model-value="flip(card)"
            />
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

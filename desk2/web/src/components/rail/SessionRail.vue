<script setup lang="ts">
// The session rail (owner, 2026-10-14, after Claude Desktop's), in place of the session header's bar and the docked Background
// tasks panel: cards beside the chat on the page's own background, saying where the session runs and what it is doing.
// Environment (folder, account, model), Context, the session's To-dos while it keeps a checklist (TodoWrite, or Claude Desktop's
// update_plan read as one), the Connectors its chats get, and Background tasks. A task, or that card's name, slides the rail over
// to the Background tasks panel, whose back arrow slides the cards back (owner: "the sidebar should slide over and show me"); a
// running task's Stop shows on hover and stops it at once. An outside session's facts and actions are its session header's,
// drawn into the cards here (RAIL_TARGETS). DeskFrame places the rail and keeps the chat's text column clear of it.
import { computed, effectScope, onBeforeUnmount, onMounted, ref, shallowRef, toRef, watch, type EffectScope, type Ref } from 'vue'
import { Blocks, Check, Gauge, ListChecks, ListTodo, LoaderCircle, MonitorCog, Sparkles, UserRound, X } from '@lucide/vue'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { newSessionGlyphs } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { useDesk } from '@/stores/desk'
import { useShellSource } from '@/components/shell/source'
import { modelName } from '@/components/shell/logic'
import { effortLabel } from '@/components/composer/logic'
import { folderLabel } from '@/components/sidebar/logic'
import { accountTitle } from '@/components/accounts/format'
import TodoList from '@/components/transcript/parts/TodoList.vue'
import { connectorList, watchConnectors } from '@/components/connectors/connections-api'
import { useClock } from '@/lib/clock'
import { lazyPanel } from '@/lib/lazy-panel'
import { cleared } from '@/components/tasks/api'
import { canStop, elapsedOf, panelLists, type TaskUnit } from '@/components/tasks/logic'
import { useSessionTasks } from '@/components/tasks/session'
import { holdPeek } from '@/components/session-header/state'
import RailCard from './RailCard.vue'
import { RAIL_TARGETS, railTargets } from './state'
const BackgroundTasksPanel = lazyPanel(() => import('@/components/tasks/BackgroundTasksPanel.vue'))

const props = defineProps<{
  /** The Hydra Desk chat on view; null for an outside session. */
  chat: ChatSummary | null
  /** An outside session is on view: its facts come from its session header. */
  outside: boolean
  items: TranscriptItem[]
  sessionId: string | null | undefined
  workerIds?: readonly string[]
  /** The chat whose background tasks get Stop; null for an outside session. */
  chatId?: string | null
  climayte?: boolean
  /** The Background tasks panel over the cards and the task it opened on; null shows the cards. */
  tasks: { focus: string | null } | null
}>()
const emit = defineEmits<{ 'open-tasks': [focus: string | null]; back: []; close: []; 'toggle-expand': [] }>()

const src = useShellSource()
const desk = useDesk()

// The panel stays drawn while it slides back out, on the task it showed.
const PANEL_MS = 420
const panelOn = ref(!!props.tasks)
const panelFocus = ref<string | null>(props.tasks?.focus ?? null)
let panelTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.tasks,
  (t) => {
    clearTimeout(panelTimer)
    if (t) {
      panelOn.value = true
      panelFocus.value = t.focus
    } else panelTimer = setTimeout(() => (panelOn.value = false), PANEL_MS)
  }
)

// An outside session's header draws into the cards once they are in the page.
watch(
  () => props.outside,
  (on) => (railTargets.value = on),
  { flush: 'post', immediate: true }
)
onBeforeUnmount(() => {
  railTargets.value = false
  clearTimeout(panelTimer)
})

// Environment and Context: a Hydra Desk chat's own; an outside session's come from its header.
const SERVICE: Record<string, string> = { codex: 'Codex', chatgpt: 'ChatGPT' }
const account = computed(() => {
  const c = props.chat
  if (!c) return null
  return c.service ? (SERVICE[c.service] ?? c.service) : accountTitle(c.account)
})
const model = computed(() => (props.chat ? `${modelName(props.chat.model)} · ${effortLabel(props.chat.effort)}` : ''))
const revealFolder = () => props.chat && void src.revealFolder(props.chat.cwd).catch(() => {}) // floor-ok: a folder gone since leaves the row as it is
const context = computed(() => (props.chat?.contextPct == null ? null : Math.round(props.chat.contextPct)))
const contextColor = computed(() => (context.value === null ? '' : context.value >= 90 ? 'var(--danger)' : context.value >= 75 ? 'var(--warning)' : 'var(--accent)'))
const cost = computed(() => (props.chat && props.chat.costUsd > 0 ? `$${props.chat.costUsd.toFixed(2)}` : ''))

// To-dos: the session's latest checklist, while it has one.
const todos = computed(() => {
  for (let i = props.items.length - 1; i >= 0; i--) {
    const it = props.items[i]!
    if (it.kind === 'todos') return it.todos.length ? it.todos : null
  }
  return null
})
const todosDone = computed(() => todos.value?.filter((t) => t.status === 'completed').length ?? 0)

// Connectors: the ones a chat started now gets (Hydra Desk chats only; an outside session's app has its own).
const CONNECTORS_SHOWN = 3
const connectors = computed(() => (props.chat ? (connectorList.value ?? []).filter((c) => c.givesChats) : []))
const connectorsOpen = ref(false)
const connectorsShown = computed(() => (connectorsOpen.value ? connectors.value : connectors.value.slice(0, CONNECTORS_SHOWN)))
let stopConnectors: (() => void) | null = null
onMounted(() => (stopConnectors = watchConnectors(() => 30_000)))
onBeforeUnmount(() => stopConnectors?.())

// Background tasks: what the panel lists for this session, its running ones each a row.
const own = useSessionTasks(toRef(props, 'sessionId'))
const lists = computed(() =>
  panelLists({ workers: src.workers.value, items: props.items, jobs: [...desk.swarmJobs.value, ...desk.remoteSwarmJobs.value], own: own.value, sessionId: props.sessionId, workerIds: props.workerIds, cleared: cleared.value, chatId: props.chatId })
)
// A 1 s clock only while something runs; the elapsed time is all it moves.
const frozenNow = Date.now()
const clock = shallowRef<{ now: Readonly<Ref<number>> } | null>(null)
const now = computed(() => clock.value?.now.value ?? frozenNow)
let clockScope: EffectScope | null = null
watch(
  () => lists.value.running.length > 0,
  (on) => {
    if (on && !clockScope) {
      clockScope = effectScope()
      const tick = clockScope.run(() => useClock(1000))
      clock.value = tick ? { now: tick } : null
    } else if (!on && clockScope) {
      clockScope.stop()
      clockScope = null
      clock.value = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => clockScope?.stop())

// Stop: at once, the row saying so until the task leaves the running list.
const stopping = ref(new Set<string>())
const stopError = ref('')
watch(
  () => lists.value.running.map((u) => u.id),
  (ids) => {
    const left = [...stopping.value].filter((id) => ids.includes(id))
    if (left.length !== stopping.value.size) stopping.value = new Set(left)
  }
)
async function stop(u: TaskUnit) {
  stopping.value = new Set(stopping.value).add(u.id)
  stopError.value = ''
  const failed: string[] = []
  const why = (e: unknown) => failed.push(e instanceof Error ? e.message : String(e))
  for (const id of u.stoppable) await desk.cancelWorker(id).catch(why)
  if (u.stopTask && props.chatId) await desk.stopTask(props.chatId, u.stopTask).catch(why)
  if (!failed.length) return
  const next = new Set(stopping.value)
  next.delete(u.id)
  stopping.value = next
  stopError.value = `Not stopped: ${failed[0]}`
}

const ROW = 'flex h-7 min-w-0 items-center gap-2 rounded-(--radius-6) px-1.5'
const ROW_BTN = `${ROW} w-full text-start outline-none transition-colors duration-60 hover:bg-fill-hover focus-visible:shadow-(--focus-ring)`
</script>

<template>
  <div class="relative size-full overflow-hidden" @pointerenter="holdPeek(true)" @pointerleave="holdPeek(false)">
    <div
      class="flex h-full w-[200%] transition-transform duration-(--dur-slow) ease-(--ease-snap) motion-reduce:transition-none"
      :style="{ transform: tasks ? 'translateX(-50%)' : 'translateX(0)' }"
    >
      <!-- The cards: only they take the pointer, so the transcript under the rail's empty part still scrolls and clicks. -->
      <div class="pointer-events-none flex h-full w-1/2 min-w-0 flex-col gap-2 overflow-y-auto pb-2" :inert="!!tasks" :aria-hidden="!!tasks || undefined">
        <RailCard id="environment" title="Environment" :icon="MonitorCog">
          <template v-if="outside" #end>
            <div :id="RAIL_TARGETS.actions" class="-me-1 flex items-center gap-0.5" />
          </template>
          <div v-if="outside" :id="RAIL_TARGETS.environment" class="flex flex-wrap items-center gap-1.5" />
          <ul v-else-if="chat" class="-mx-1.5 flex flex-col">
            <li>
              <Tip :label="`Open ${chat.cwd}`">
                <button type="button" :class="ROW_BTN" :aria-label="`Folder ${folderLabel(chat.cwd)}, open it`" @click="revealFolder">
                  <component :is="newSessionGlyphs.folder" class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate text-text">{{ folderLabel(chat.cwd) }}</span>
                </button>
              </Tip>
            </li>
            <li :class="ROW">
              <UserRound class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-text-2">{{ account }}</span>
            </li>
            <li :class="ROW">
              <Sparkles class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-text-2">{{ model }}</span>
            </li>
          </ul>
        </RailCard>

        <RailCard v-if="outside || context !== null" id="context" title="Context" :icon="Gauge">
          <template v-if="!outside" #end>
            <span class="tnum text-text-muted">{{ context }}% used</span>
          </template>
          <div v-if="outside" :id="RAIL_TARGETS.context" class="flex flex-wrap items-center gap-1.5" />
          <template v-else>
            <div class="h-1.5 overflow-hidden rounded-full bg-(--fill-5)" role="meter" aria-label="Context used" :aria-valuenow="context ?? 0" aria-valuemin="0" aria-valuemax="100">
              <div class="h-full rounded-full" :style="{ width: `${context}%`, background: contextColor }" />
            </div>
            <p v-if="cost" class="tnum mt-1.5 text-text-muted">{{ cost }} spent</p>
          </template>
        </RailCard>

        <RailCard v-if="todos" id="todos" title="To-dos" :icon="ListTodo">
          <template #end>
            <span class="tnum text-text-muted">{{ todosDone }} of {{ todos.length }} done</span>
          </template>
          <TodoList :todos="todos" dense />
        </RailCard>

        <RailCard v-if="connectors.length" id="connectors" title="Connectors" :icon="Blocks">
          <template #end>
            <span class="tnum text-text-muted">{{ connectors.length }}</span>
          </template>
          <ul class="-mx-1.5 flex flex-col">
            <li v-for="c in connectorsShown" :key="c.id" :class="ROW">
              <span class="flex size-4 shrink-0 items-center justify-center rounded-(--radius-5) bg-(--fill-secondary) text-3xs font-medium text-text-2" aria-hidden="true">{{ c.name.slice(0, 1).toUpperCase() }}</span>
              <span class="min-w-0 flex-1 truncate text-text-2">{{ c.name }}</span>
              <Tip v-if="c.state === 'failed'" :label="c.reason || 'Not running'">
                <X class="size-3.5 shrink-0 text-danger-text" aria-label="Not running" />
              </Tip>
              <LoaderCircle v-else-if="c.state === 'starting' || c.state === 'installing'" class="size-3.5 shrink-0 animate-spin text-text-muted" aria-label="Starting" />
            </li>
          </ul>
          <button
            v-if="connectors.length > CONNECTORS_SHOWN"
            type="button"
            class="mt-0.5 rounded-(--radius-5) px-0.5 text-text-muted transition-colors duration-60 hover:text-text"
            :aria-expanded="connectorsOpen"
            @click="connectorsOpen = !connectorsOpen"
          >
            {{ connectorsOpen ? 'Show fewer' : `Show ${connectors.length - CONNECTORS_SHOWN} more` }}
          </button>
        </RailCard>

        <RailCard id="tasks" title="Background tasks" :icon="ListChecks" opens @open="emit('open-tasks', null)">
          <template #end>
            <span class="tnum text-text-muted">{{ lists.running.length ? `${lists.running.length} running` : 'None running' }}</span>
          </template>
          <ul v-if="lists.running.length" class="-mx-1.5 flex flex-col" aria-label="Running">
            <li v-for="u in lists.running" :key="u.id" class="group/task relative">
              <button type="button" :class="ROW_BTN" class="pe-8" :aria-label="`${u.name}, show it in Background tasks`" @click="emit('open-tasks', u.id)">
                <LoaderCircle class="size-3.5 shrink-0 animate-spin text-text-muted" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-text-2">{{ u.name }}</span>
              </button>
              <span class="pointer-events-none absolute inset-y-0 right-1.5 flex items-center">
                <span v-if="stopping.has(u.id)" class="text-text-muted">Stopping…</span>
                <span v-else class="tnum text-text-muted" :class="canStop(u) && 'group-hover/task:hidden group-focus-within/task:hidden'">{{ elapsedOf(u.startedAt, u.endedAt, now) }}</span>
              </span>
              <Tip v-if="canStop(u) && !stopping.has(u.id)" :label="`Stop ${u.name}`" side="left">
                <button
                  type="button"
                  class="absolute right-1 top-1 hidden size-5 items-center justify-center rounded-sm bg-white/10 text-text outline-none transition-colors duration-60 hover:bg-white/20 focus-visible:flex focus-visible:shadow-(--focus-ring) group-hover/task:flex group-focus-within/task:flex"
                  :aria-label="`Stop ${u.name}`"
                  @click="stop(u)"
                >
                  <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="1.5" /></svg>
                </button>
              </Tip>
            </li>
          </ul>
          <p v-if="stopError" class="mt-1 text-danger-text" role="alert">{{ stopError }}</p>
          <div v-if="lists.finished.length" class="-mx-1.5">
            <button type="button" :class="ROW_BTN" :aria-label="`${lists.finished.length} finished, show them in Background tasks`" @click="emit('open-tasks', lists.finished[0]!.id)">
              <Check class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              <span class="tnum min-w-0 flex-1 truncate text-text-muted">{{ lists.finished.length }} finished</span>
            </button>
          </div>
        </RailCard>
      </div>

      <div class="h-full w-1/2 min-w-0 pb-2" :inert="!tasks" :aria-hidden="!tasks || undefined">
        <BackgroundTasksPanel
          v-if="panelOn"
          :session-id="sessionId"
          :worker-ids="workerIds"
          :items="items"
          :chat-id="chatId"
          :climayte="climayte"
          :focus-id="panelFocus"
          back
          @back="emit('back')"
          @close="emit('close')"
          @toggle-expand="emit('toggle-expand')"
        />
      </div>
    </div>
  </div>
</template>

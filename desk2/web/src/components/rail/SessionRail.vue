<script setup lang="ts">
// The session rail (owner, 2026-10-14, after Claude Desktop's), in place of the session header's bar and the docked Background
// tasks panel: cards beside the chat, each its name and a chevron that folds it, then rows of a gray icon and the fact, as
// Claude Desktop draws them (owner: "the items don't look anything like the design I gave you"). Environment (where it runs:
// account, folder, model), Context, the session's To-dos while it keeps a checklist (TodoWrite, or Claude Desktop's update_plan
// read as one), Connectors (a Desk chat's, or the MCP servers an outside session used), and Background tasks. A task, or the
// finished count, slides the rail over to the Background tasks panel, whose back arrow slides the cards back (owner: "the
// sidebar should slide over and show me"); every running task's Stop shows on hover, and one Desk cannot reach says so. An
// outside session's facts and actions are its session header's, drawn into the cards here (RAIL_TARGETS). DeskFrame places the
// rail and keeps the chat's text column clear of it.
import { computed, effectScope, onBeforeUnmount, onMounted, ref, shallowRef, toRef, watch, type EffectScope, type Ref } from 'vue'
import { CircleCheck, LoaderCircle, Sparkles, UserRound, X } from '@lucide/vue'
import type { ChatSummary, TranscriptIndex, TranscriptItem } from '@shared/protocol'
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
import { canStop, elapsedOf, latestTodoList, panelLists, type TaskUnit } from '@/components/tasks/logic'
import { useSessionTasks } from '@/components/tasks/session'
import { holdPeek } from '@/components/session-header/state'
import RailCard from './RailCard.vue'
import { RAIL_ICON, RAIL_ICON_BTN, RAIL_ROW, RAIL_ROW_BTN, RAIL_TILE } from './classes'
import { RAIL_TARGETS, railTargets } from './state'
const BackgroundTasksPanel = lazyPanel(() => import('@/components/tasks/BackgroundTasksPanel.vue'))

const props = defineProps<{
  /** The Hydra Desk chat on view; null for an outside session. */
  chat: ChatSummary | null
  /** An outside session is on view: its facts come from its session header. */
  outside: boolean
  items: TranscriptItem[]
  /** The whole transcript's index (null where none was read). */
  index?: TranscriptIndex | null
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
const cost = computed(() => (props.chat && props.chat.costUsd > 0 ? `$${props.chat.costUsd.toFixed(2)} spent` : ''))

// To-dos: the session's latest checklist, while it has one.
const todos = computed(() => latestTodoList(props.items, props.index))
const todosDone = computed(() => todos.value?.filter((t) => t.status === 'completed').length ?? 0)

// Connectors: a Desk chat's are the ones a chat started now gets; an outside session's app keeps its own list, so its card
// names the MCP servers its tools came from (mcp__<server>__<tool>), first used first.
interface RailConnector {
  id: string
  name: string
  state?: string
  reason?: string
}
const CONNECTORS_SHOWN = 3
const serverName = (id: string) => {
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
const usedServers = computed<RailConnector[]>(() => {
  const seen = new Map<string, RailConnector>()
  for (const it of props.items) {
    if (it.kind !== 'tool_use' || !it.name.startsWith('mcp__')) continue
    const id = it.name.slice(5).split('__')[0]
    if (id && !seen.has(id)) seen.set(id, { id, name: serverName(id) })
  }
  return [...seen.values()]
})
const connectors = computed<RailConnector[]>(() => (props.chat ? (connectorList.value ?? []).filter((c) => c.givesChats) : usedServers.value))
const connectorsOpen = ref(false)
const connectorsShown = computed(() => (connectorsOpen.value ? connectors.value : connectors.value.slice(0, CONNECTORS_SHOWN)))
let stopConnectors: (() => void) | null = null
onMounted(() => (stopConnectors = watchConnectors(() => 30_000)))
onBeforeUnmount(() => stopConnectors?.())

// Background tasks: what the panel lists for this session, its running ones each a row.
const own = useSessionTasks(toRef(props, 'sessionId'))
const lists = computed(() =>
  panelLists({ workers: src.workers.value, items: props.items, index: props.index, jobs: [...desk.swarmJobs.value, ...desk.remoteSwarmJobs.value], own: own.value, sessionId: props.sessionId, workerIds: props.workerIds, cleared: cleared.value, chatId: props.chatId })
)
const tasksSummary = computed(() => (lists.value.running.length ? `${lists.value.running.length} running` : 'None running'))
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
// A task Desk cannot reach (a shell an outside session started) keeps its Stop, greyed, with the reason on it.
const NO_STOP = 'Only the session that started it can stop this task'
</script>

<template>
  <!-- Clipped, never a scroll box (2026-10-14): with overflow-hidden, the panel's scrollIntoView of its chosen task scrolled
       this box sideways as the slide began, and the panel landed one rail-width left of the rail, under the chat. -->
  <div class="relative size-full overflow-clip" @pointerenter="holdPeek(true)" @pointerleave="holdPeek(false)">
    <div
      class="flex h-full w-[200%] transition-transform duration-(--dur-slow) ease-(--ease-snap) motion-reduce:transition-none"
      :style="{ transform: tasks ? 'translateX(-50%)' : 'translateX(0)' }"
    >
      <!-- The cards: only they take the pointer, so the transcript under the rail's empty part still scrolls and clicks. -->
      <div class="pointer-events-none flex h-full w-1/2 min-w-0 flex-col gap-2.5 overflow-y-auto pb-2" :inert="!!tasks" :aria-hidden="!!tasks || undefined">
        <RailCard id="environment" title="Environment">
          <template v-if="outside" #actions>
            <div :id="RAIL_TARGETS.actions" class="flex items-center" />
          </template>
          <div v-if="outside" :id="RAIL_TARGETS.environment" class="flex flex-col" />
          <ul v-else-if="chat" class="flex flex-col">
            <li>
              <Tip :label="`Open ${chat.cwd}`">
                <button type="button" :class="RAIL_ROW_BTN" :aria-label="`Folder ${folderLabel(chat.cwd)}, open it`" @click="revealFolder">
                  <component :is="newSessionGlyphs.folder" :class="RAIL_ICON" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate text-text">{{ folderLabel(chat.cwd) }}</span>
                </button>
              </Tip>
            </li>
            <li :class="RAIL_ROW">
              <UserRound :class="RAIL_ICON" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-text">{{ account }}</span>
            </li>
            <li :class="RAIL_ROW">
              <Sparkles :class="RAIL_ICON" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-text">{{ model }}</span>
            </li>
          </ul>
        </RailCard>

        <RailCard v-if="outside || context !== null" id="context" title="Context" :summary="context === null ? undefined : `${context}% used`">
          <div v-if="outside" :id="RAIL_TARGETS.context" class="flex flex-col" />
          <div v-else class="px-1.5 pb-1.5">
            <div class="flex h-6.5 items-center gap-2">
              <span class="tnum font-medium text-text">{{ context }}% used</span>
              <span class="min-w-0 flex-1" />
              <span v-if="cost" class="tnum truncate text-ui-sm text-text-muted">{{ cost }}</span>
            </div>
            <div class="h-1 overflow-hidden rounded-full bg-(--fill-secondary)" role="meter" aria-label="Context used" :aria-valuenow="context ?? 0" aria-valuemin="0" aria-valuemax="100">
              <div class="h-full rounded-full" :style="{ width: `${context}%`, background: contextColor }" />
            </div>
          </div>
        </RailCard>

        <RailCard v-if="todos" id="todos" title="To-dos" :summary="`${todosDone} of ${todos.length} done`">
          <div class="px-1.5 pb-1">
            <TodoList :todos="todos" dense />
          </div>
        </RailCard>

        <RailCard v-if="connectors.length" id="connectors" title="Connectors" :summary="String(connectors.length)">
          <ul class="flex flex-col">
            <li v-for="c in connectorsShown" :key="c.id" :class="RAIL_ROW">
              <span :class="RAIL_TILE" aria-hidden="true">{{ c.name.slice(0, 1).toUpperCase() }}</span>
              <span class="min-w-0 flex-1 truncate text-text">{{ c.name }}</span>
              <Tip v-if="c.state === 'failed'" :label="c.reason || 'Not running'">
                <X class="size-4 shrink-0 text-danger-text" aria-label="Not running" />
              </Tip>
              <LoaderCircle v-else-if="c.state === 'starting' || c.state === 'installing'" class="size-4 shrink-0 animate-spin text-text-muted" aria-label="Starting" />
            </li>
          </ul>
          <button
            v-if="connectors.length > CONNECTORS_SHOWN"
            type="button"
            class="mb-0.5 cursor-default rounded-(--radius-6) px-1.5 text-text-muted outline-none transition-colors duration-60 hover:text-text focus-visible:shadow-(--focus-ring)"
            :aria-expanded="connectorsOpen"
            @click="connectorsOpen = !connectorsOpen"
          >
            {{ connectorsOpen ? 'Show less' : 'Show more' }}
          </button>
        </RailCard>

        <RailCard id="tasks" title="Background tasks" :summary="tasksSummary">
          <ul v-if="lists.running.length" class="flex flex-col" aria-label="Running">
            <li v-for="u in lists.running" :key="u.id" class="group/task relative">
              <button type="button" :class="RAIL_ROW_BTN" class="pe-16" :aria-label="`${u.name}, show it in Background tasks`" @click="emit('open-tasks', u.id)">
                <LoaderCircle class="size-4 shrink-0 animate-spin text-text-2" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-text">{{ u.name }}</span>
              </button>
              <span class="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-ui-sm text-text-muted">
                <span v-if="stopping.has(u.id)">Stopping…</span>
                <span v-else class="tnum group-hover/task:hidden group-focus-within/task:hidden">{{ elapsedOf(u.startedAt, u.endedAt, now) }}</span>
              </span>
              <Tip v-if="!stopping.has(u.id)" :label="canStop(u) ? `Stop ${u.name}` : NO_STOP" side="left">
                <span class="absolute inset-y-0 right-0.5 hidden items-center group-hover/task:flex group-focus-within/task:flex">
                  <button type="button" :class="RAIL_ICON_BTN" :aria-label="`Stop ${u.name}`" :disabled="!canStop(u)" @click="stop(u)">
                    <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="1.5" /></svg>
                  </button>
                </span>
              </Tip>
            </li>
          </ul>
          <p v-if="stopError" class="px-1.5 pb-1 text-ui-sm text-danger-text" role="alert">{{ stopError }}</p>
          <button
            v-if="lists.finished.length"
            type="button"
            :class="RAIL_ROW_BTN"
            :aria-label="`${lists.finished.length} finished, show them in Background tasks`"
            @click="emit('open-tasks', lists.finished[0]!.id)"
          >
            <CircleCheck :class="RAIL_ICON" aria-hidden="true" />
            <span class="tnum min-w-0 flex-1 truncate text-text-2">{{ lists.finished.length }} finished</span>
          </button>
          <p v-if="!lists.running.length && !lists.finished.length" :class="RAIL_ROW" class="text-text-muted">Nothing has run in the background</p>
        </RailCard>
      </div>

      <!-- The panel takes the pointer whole: its back arrow, Expand, the trash and every row (the rail around it lets clicks through). -->
      <div class="pointer-events-auto h-full w-1/2 min-w-0 pb-2" :inert="!tasks" :aria-hidden="!tasks || undefined">
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

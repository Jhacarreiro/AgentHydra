<script setup lang="ts">
// One routine on the Managers page: its state and why, its schedule in words, who asked for it, what it last did and when it
// runs next, with Run now, Pause or Resume, and Open chat for a prompt run's chat.
import { computed, ref } from 'vue'
import type { Routine, RoutineState } from '@shared/routines'
import { scheduleInWords } from '@shared/routines'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from './api'
import { BUTTON } from './settings-styles'

const props = defineProps<{
  /** The routine as the last look saw it (GET /api/routines). */
  routine: Routine
  /** Whether the routine manager is on: Run now waits for it. */
  enabled: boolean
}>()
/** A request was answered (run, paused, resumed, or refused): the parent re-reads the status. */
const emit = defineEmits<{ changed: [] }>()

const api = usePaneApi()
const src = useShellSource()
const busy = ref(false)
const error = ref('')

const DOT: Record<RoutineState, string> = {
  idle: 'var(--success)',
  due: 'var(--success)',
  running: 'var(--accent)',
  paused: 'var(--text-muted)',
  off: 'var(--text-muted)',
  ended: 'var(--text-muted)',
  broken: 'var(--danger)',
  waiting: 'var(--warning)',
}
const canRun = computed(() => props.enabled && !busy.value && ['idle', 'due'].includes(props.routine.state) && props.routine.kind !== null)
const last = computed(() => props.routine.runs[0])
const lastText = computed(() => (last.value ? `last run ${spanOf(Date.now() - last.value.endedAt)} ago (${last.value.outcome})` : 'never run'))
const nextText = computed(() => {
  const r = props.routine
  if (r.state === 'running') return 'running now'
  if (r.nextRunAt === null) return r.reason
  return r.nextRunAt <= Date.now() ? 'due now' : `next in ${spanOf(r.nextRunAt - Date.now())}`
})
const scheduleText = computed(() => {
  const r = props.routine
  if (r.schedule !== null) return scheduleInWords(r.schedule)
  if (r.windowsTask !== null) return `Windows: ${r.windowsTask.replace(/^\\/, '')}`
  return 'its own pace'
})
const totalsText = computed(() => Object.entries(props.routine.totals ?? {}).map(([k, n]) => `${k} ${n}`).join(' · '))
const settingRows = computed(() => Object.entries(props.routine.settings ?? {}))
/** The session of a prompt run's chat: the one running now, else the last run's. */
const chatSession = computed(() => props.routine.running?.sessionId ?? last.value?.sessionId ?? null)

/** A span of time as the page says it: 'under a minute', '12 min', '2 h', '3 d'. */
function spanOf(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m} min`
  if (m < 24 * 60) return `${Math.round(m / 60)} h`
  return `${Math.round(m / (24 * 60))} d`
}

/** Opens a routine's chat the way the sidebar opens a session: a Desk chat that has it, else its transcript. */
function openChat(sessionId: string) {
  const chat = src.chats.value.find((c) => c.sessionId === sessionId)
  if (chat) src.select({ kind: 'chat', id: chat.id })
  else src.select({ kind: 'external', id: sessionId })
}

async function act(body: Parameters<typeof api.routinesAct>[0]) {
  busy.value = true
  error.value = ''
  try {
    await api.routinesAct(body)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    emit('changed')
  }
}
</script>

<template>
  <div class="mt-2 rounded-[var(--radius-6)] bg-fill-5 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span class="text-[13px] leading-5 text-text">{{ routine.name }}</span>
      <span class="flex items-center gap-1.5 text-[12px] leading-4.5 text-text-2">
        <span class="inline-block size-2 rounded-full" :style="{ background: DOT[routine.state] }" />
        {{ routine.state }}
      </span>
      <span class="ms-auto flex gap-2">
        <button v-if="routine.kind !== null && !routine.paused" type="button" :class="BUTTON" :disabled="busy" @click="act({ pause: routine.id })">Pause</button>
        <button v-else-if="routine.kind !== null" type="button" :class="BUTTON" :disabled="busy" @click="act({ resume: routine.id })">Resume</button>
        <button type="button" :class="BUTTON" :disabled="!canRun" @click="act({ run: routine.id })">Run now</button>
      </span>
    </div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted" :title="routine.askedBy ?? undefined">
      {{ scheduleText }}<template v-if="routine.until"> · until {{ routine.until }}</template>
    </div>
    <div v-if="routine.askedBy" class="mt-0.5 truncate text-[12px] leading-4.5 text-text-muted" :title="routine.askedBy">asked for by {{ routine.askedBy }}</div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">{{ routine.headline ?? routine.reason }}</div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">{{ nextText }} · {{ lastText }}</div>
    <div v-if="last?.lastLine" class="mt-0.5 wrap-break-word font-mono text-[12px] leading-4.5 text-text-muted">{{ last.lastLine }}</div>
    <div v-if="totalsText" class="mt-0.5 tnum text-[12px] leading-4.5 text-text-muted">{{ totalsText }}</div>
    <dl v-if="settingRows.length" class="mt-2 grid gap-1">
      <div v-for="[k, v] in settingRows" :key="k" class="flex items-baseline justify-between gap-4 text-[12px] leading-4.5">
        <dt class="text-text-muted">{{ k }}</dt>
        <dd class="tnum truncate text-text-2">{{ String(v) }}</dd>
      </div>
    </dl>
    <button v-if="chatSession" type="button" :class="[BUTTON, 'mt-2']" @click="openChat(chatSession)">Open chat</button>
    <div v-if="error" role="alert" class="mt-1.5 wrap-break-word text-[12px] leading-4.5 text-danger-text">{{ error }}</div>
  </div>
</template>

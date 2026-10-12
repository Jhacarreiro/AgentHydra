<script setup lang="ts">
// One standing agent on the Managers page: what its status says, when it last ran and runs next, and a Run now button.
import { computed, ref } from 'vue'
import type { ArchAIngelAgent, ArchAIngelState } from '@shared/archaingel'
import { usePaneApi } from './api'
import { BUTTON } from './settings-styles'

const props = defineProps<{
  /** The agent as the last look saw it (GET /api/archaingel). */
  agent: ArchAIngelAgent
  /** Whether ArchAIngel is on: Run now waits for it. */
  enabled: boolean
}>()
/** A run was answered (ticked or refused): the parent re-reads the status. */
const emit = defineEmits<{ ran: [] }>()

const api = usePaneApi()
const busy = ref(false)
const error = ref('')

const DOT: Record<ArchAIngelState, string> = {
  idle: 'var(--success)',
  due: 'var(--success)',
  running: 'var(--accent)',
  off: 'var(--text-muted)',
  broken: 'var(--danger)'
}
const canRun = computed(() => props.enabled && !busy.value && !['off', 'broken', 'running'].includes(props.agent.state))
const last = computed(() => props.agent.runs[0])
const lastText = computed(() => (last.value ? `last run ${spanOf(Date.now() - last.value.endedAt)} ago (${last.value.outcome})` : 'never run'))
const nextText = computed(() => {
  const a = props.agent
  if (a.state === 'running') return 'running now'
  return a.nextTickAt === null || a.nextTickAt <= Date.now() ? 'due now' : `next in ${spanOf(a.nextTickAt - Date.now())}`
})
const totalsText = computed(() => Object.entries(props.agent.totals ?? {}).map(([k, n]) => `${k} ${n}`).join(' · '))
const settingRows = computed(() => Object.entries(props.agent.settings ?? {}))

/** A span of time as the page says it: 'under a minute', '12 min', '2 h', '3 d'. */
function spanOf(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m} min`
  if (m < 24 * 60) return `${Math.round(m / 60)} h`
  return `${Math.round(m / (24 * 60))} d`
}

async function run() {
  busy.value = true
  error.value = ''
  try {
    await api.archaingelRun(props.agent.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    emit('ran')
  }
}
</script>

<template>
  <div class="mt-2 rounded-[var(--radius-6)] bg-fill-5 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span class="text-[13px] leading-5 text-text">{{ agent.name }}</span>
      <span class="flex items-center gap-1.5 text-[12px] leading-4.5 text-text-2">
        <span class="inline-block size-2 rounded-full" :style="{ background: DOT[agent.state] }" />
        {{ agent.state }}
      </span>
      <button type="button" :class="[BUTTON, 'ms-auto']" :disabled="!canRun" @click="run">Run now</button>
    </div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">{{ agent.headline ?? agent.reason }}</div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">{{ nextText }} · {{ lastText }}</div>
    <div v-if="last?.lastLine" class="mt-0.5 wrap-break-word font-mono text-[12px] leading-4.5 text-text-muted">{{ last.lastLine }}</div>
    <div v-if="totalsText" class="mt-0.5 tnum text-[12px] leading-4.5 text-text-muted">{{ totalsText }}</div>
    <dl v-if="settingRows.length" class="mt-2 grid gap-1">
      <div v-for="[k, v] in settingRows" :key="k" class="flex items-baseline justify-between gap-4 text-[12px] leading-4.5">
        <dt class="text-text-muted">{{ k }}</dt>
        <dd class="tnum truncate text-text-2">{{ String(v) }}</dd>
      </div>
    </dl>
    <div v-if="error" role="alert" class="mt-1.5 wrap-break-word text-[12px] leading-4.5 text-danger-text">{{ error }}</div>
  </div>
</template>

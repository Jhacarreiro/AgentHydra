<script setup lang="ts">
// A routine an AI proposed, waiting for the owner's yes: why it should be a routine, when it runs, what it does, and
// Approve (it runs from then on) or Discard (its file is deleted). An AI can never approve one.
import { computed, ref } from 'vue'
import type { RoutineProposal } from '@shared/routines'
import { scheduleInWords } from '@shared/routines'
import { usePaneApi } from './api'
import { BUTTON } from './settings-styles'

const props = defineProps<{ proposal: RoutineProposal }>()
/** Approved or discarded: the parent re-reads the status. */
const emit = defineEmits<{ changed: [] }>()

const api = usePaneApi()
const busy = ref(false)
const error = ref('')

const when = computed(() => {
  const p = props.proposal
  if (p.schedule !== undefined) return scheduleInWords(p.schedule)
  if (p.windowsTask !== undefined) return `Windows: ${p.windowsTask.replace(/^\\/, '')}`
  return 'its own pace'
})
const what = computed(() => {
  const p = props.proposal
  if (p.prompt !== undefined) return `An AI prompt in ${p.cwd ?? 'its folder'}: ${p.prompt.slice(0, 200)}`
  if (p.run !== undefined) return `A command: ${p.run.join(' ')}`
  if (p.status !== undefined) return `A status command: ${p.status.join(' ')}`
  return 'Windows runs it'
})

async function act(body: { approve: string } | { discard: string }) {
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
      <span class="text-[13px] leading-5 text-text">{{ proposal.name }}</span>
      <span class="flex items-center gap-1.5 text-[12px] leading-4.5 text-text-2">
        <span class="inline-block size-2 rounded-full" style="background: var(--warning)" />
        waiting
      </span>
      <span class="ms-auto flex gap-2">
        <button type="button" :class="BUTTON" :disabled="busy" @click="act({ discard: proposal.id })">Discard</button>
        <button type="button" :class="BUTTON" :disabled="busy" @click="act({ approve: proposal.id })">Approve</button>
      </span>
    </div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-2">Why: {{ proposal.why }}</div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">When: {{ when }}<template v-if="proposal.until"> · until {{ proposal.until }}</template></div>
    <div class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">What: {{ what }}</div>
    <div class="mt-0.5 truncate text-[12px] leading-4.5 text-text-muted" :title="proposal.askedBy">asked for by {{ proposal.askedBy }}</div>
    <div v-if="error" role="alert" class="mt-1.5 wrap-break-word text-[12px] leading-4.5 text-danger-text">{{ error }}</div>
  </div>
</template>

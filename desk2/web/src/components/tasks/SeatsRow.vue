<script setup lang="ts">
// The seats this chat opened, in one muted line under its last message, above the tasks line (RunningTasksRow.vue):
// '4 seats · Mia needs you · Ava, Leo working · 2 agents running · about 1 h 10 min left' (seats.ts). Each name
// opens that seat's chat; nothing renders for a chat that opened no seat.
import { computed } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { seatCount, seatsLabel, seatsOf, seatsTail } from './seats'
import { useClockWhile } from './useClockWhile'

const props = defineProps<{ chat: ChatSummary }>()
const src = useShellSource()

const summary = computed(() => seatsOf(props.chat, src.chats.value, src.workers.value))
// A 15 s clock, only while an estimate or a start time is on show: the line counts whole minutes.
const now = useClockWhile(() => !!summary.value && (summary.value.etaEndsAt !== null || summary.value.since !== null), 15_000, () => Date.now())
const tail = computed(() => (summary.value ? seatsTail(summary.value, now.value) : []))
const label = computed(() => (summary.value ? seatsLabel(summary.value, now.value) : ''))
</script>

<template>
  <div v-if="summary" class="mt-3 flex min-h-6 flex-wrap items-center gap-x-1 px-1 text-ui-lg text-(--text-muted)" data-seats :aria-label="label">
    <span>{{ seatCount(summary.total) }}</span>
    <template v-if="summary.groups.length">
      <span v-for="g in summary.groups" :key="g.state" :class="g.state === 'needs_you' ? 'text-(--warning-text)' : g.state === 'error' ? 'text-(--danger-text)' : ''">
        <span aria-hidden="true" class="text-(--text-muted)">· </span>
        <template v-for="(s, i) in g.seats" :key="s.id">
          <span v-if="i" aria-hidden="true">, </span>
          <button
            type="button"
            class="rounded-sm outline-none transition-colors duration-60 hover:text-(--text-2) hover:underline focus-visible:shadow-(--focus-ring)"
            :title="s.activity ? `${s.name}: ${s.activity}` : `Open ${s.name}`"
            @click="src.select({ kind: 'chat', id: s.id })"
          >{{ s.name }}</button>
        </template>
        {{ g.verb }}
      </span>
    </template>
    <span v-else><span aria-hidden="true">·</span> none working</span>
    <span v-for="t in tail" :key="t"><span aria-hidden="true">·</span> {{ t }}</span>
  </div>
</template>

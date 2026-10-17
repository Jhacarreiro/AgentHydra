<script setup lang="ts">
// The Urgency Advisor's nudge, sent to the chat on the owner's behalf: on the owner's side like his own bubble, but
// dark orange, with his face and "<Name> · Urgency Advisor" above it. Never the owner's plain bubble or the grey program note.
// One still waiting behind a running turn is dimmed and says so; the chat reads it at its next step.
import { computed, ref } from 'vue'
import type { TranscriptItem } from '@shared/protocol'

const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'note' }> }>()
const when = computed(() => new Date(props.item.ts).toLocaleString(undefined, { hour12: false }))
const initial = computed(() => (Array.from(props.item.from.trim())[0] ?? '?').toUpperCase())
// His photo is avatar.* in his people folder (server/src/urgency-advisor.ts PERSONA_SLUG); without one, his initial.
const ADVISOR_SLUG = 'duke-urgency-advisor'
const broken = ref(false)
</script>

<template>
  <div class="ms-auto flex max-w-[85%] flex-col items-end gap-1" :title="when" data-advisor>
    <span class="flex items-center gap-1.5 px-1 text-ui text-text-muted">
      <span class="tx-advisor-face" aria-hidden="true">
        <img
          v-if="!broken"
          :src="`/api/managers/${ADVISOR_SLUG}/avatar`"
          alt=""
          decoding="async"
          class="size-full origin-top scale-160 object-cover"
          @error="broken = true"
        />
        <span v-else class="text-3xs font-semibold leading-none">{{ initial }}</span>
      </span>
      {{ item.from }} · Urgency Advisor
    </span>
    <div class="tx-bubble tx-bubble-advisor" :class="item.queued && 'opacity-60'">
      <p class="whitespace-pre-wrap wrap-break-word">{{ item.text }}</p>
    </div>
    <span v-if="item.queued" class="px-1 text-ui text-text-muted" data-advisor-queued>Waiting, the chat reads it at its next step</span>
  </div>
</template>

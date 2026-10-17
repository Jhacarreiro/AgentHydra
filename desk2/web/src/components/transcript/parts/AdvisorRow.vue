<script setup lang="ts">
// The Urgency Advisor's nudge, sent to the chat on the owner's behalf: on the owner's side like his own bubble, but
// dark orange, with "<Name> · Urgency Advisor" above it. Never the owner's plain bubble or the grey program note.
import { computed } from 'vue'
import type { TranscriptItem } from '@shared/protocol'

const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'note' }> }>()
const when = computed(() => new Date(props.item.ts).toLocaleString(undefined, { hour12: false }))
</script>

<template>
  <div class="ms-auto flex max-w-[85%] flex-col items-end gap-1" :title="when" data-advisor>
    <span class="px-1 text-ui text-text-muted">{{ item.from }} · Urgency Advisor</span>
    <div class="tx-bubble tx-bubble-advisor">
      <p class="whitespace-pre-wrap wrap-break-word">{{ item.text }}</p>
    </div>
  </div>
</template>

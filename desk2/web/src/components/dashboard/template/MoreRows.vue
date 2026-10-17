<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'
import { BTN_GHOST_SM } from '@/components/servers/info/kit/kit'

// "Show 26 more" under a section's first rows; it turns to "Show fewer" and folds them back.
defineProps<{ hidden: number; open: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <div v-if="hidden > 0" class="px-2.5 py-1.5">
    <button type="button" :class="BTN_GHOST_SM" :aria-expanded="open" @click="emit('toggle')">
      {{ open ? 'Show fewer' : `Show ${hidden} more` }}
      <ChevronDown class="size-3.5 transition-transform duration-150" :class="open && 'rotate-180'" aria-hidden="true" />
    </button>
  </div>
</template>

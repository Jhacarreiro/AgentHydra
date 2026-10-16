<script setup lang="ts">
// The usage ring the account menu's button draws (AccountMenu.vue, which says the numbers): a 14px progress ring (the
// real one draws its arc in the accent blue; Hydra Desk turns it amber at 75% and red at 90%).
import { computed } from 'vue'

const props = defineProps<{ pct: number | null }>()

const R = 5.5
const C = 2 * Math.PI * R
const value = computed(() => Math.max(0, Math.min(100, props.pct ?? 0)))
const dash = computed(() => `${(value.value / 100) * C} ${C}`)
const color = computed(() => (value.value >= 90 ? 'var(--danger)' : value.value >= 75 ? 'var(--warning)' : 'var(--accent)'))
</script>

<template>
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" :r="R" fill="none" stroke="var(--border)" stroke-width="2" />
    <circle
      v-if="pct != null && value > 0"
      cx="7"
      cy="7"
      :r="R"
      fill="none"
      :stroke="color"
      stroke-width="2"
      stroke-linecap="round"
      :stroke-dasharray="dash"
      transform="rotate(-90 7 7)"
    />
  </svg>
</template>

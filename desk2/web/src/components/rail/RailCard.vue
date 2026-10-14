<script setup lang="ts">
// One card of the session rail: its name, what it says at a glance on the right, then its rows. Its name folds it (remembered per
// card) or, for a card that opens a page of its own (`opens`), opens that page, with › to say so.
import { computed, type Component } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { foldedCards, toggleCard } from './state'

const props = defineProps<{ id: string; title: string; icon: Component; opens?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const folded = computed(() => !props.opens && foldedCards.value.has(props.id))
const onName = () => (props.opens ? emit('open') : toggleCard(props.id))
</script>

<template>
  <section class="pointer-events-auto rounded-(--radius-10) border border-(--border) bg-(--bg-panel) text-ui-sm leading-4" :aria-label="title" :data-rail-card="id">
    <header class="flex h-8 min-w-0 items-center gap-1 ps-1.5 pe-2">
      <button
        type="button"
        class="flex h-6 min-w-0 items-center gap-1.5 rounded-(--radius-6) px-1 text-text-2 outline-none transition-colors duration-60 hover:text-text focus-visible:shadow-(--focus-ring)"
        :aria-expanded="opens ? undefined : !folded"
        @click="onName"
      >
        <component :is="icon" class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        <span class="truncate font-medium">{{ title }}</span>
        <ChevronRight class="size-3 shrink-0 text-text-muted transition-transform duration-150" :class="!opens && !folded && 'rotate-90'" aria-hidden="true" />
      </button>
      <span class="min-w-0 flex-1" />
      <slot name="end" />
    </header>
    <div v-show="!folded" class="px-2.5 pb-2.5">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { CARD } from '@/components/servers/info/kit/kit'

// One section of the template: its icon and title (a dot before the title while a list that needs the person has
// rows), a count or badge on the right, then its rows edge to edge, or the one line that says why it is empty.
defineProps<{ title: string; icon: Component; dot?: boolean; empty?: string | null }>()
</script>

<template>
  <section :class="CARD" class="min-w-0" :aria-label="title">
    <header class="flex min-h-10 items-center gap-2 px-4">
      <component :is="icon" class="size-3.5 shrink-0 text-text-2" aria-hidden="true" />
      <span v-if="dot" class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
      <h3 class="min-w-0 flex-1 truncate text-ui font-medium leading-5 text-text">{{ title }}</h3>
      <div v-if="$slots.meta" class="flex shrink-0 items-center gap-1.5 text-ui-sm leading-4 text-text-muted tnum"><slot name="meta" /></div>
    </header>
    <p v-if="empty" class="px-4 pb-3 text-ui-sm leading-4.5 text-text-muted">{{ empty }}</p>
    <slot v-else />
  </section>
</template>

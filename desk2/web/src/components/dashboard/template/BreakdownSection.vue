<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BreakdownData, FilledSection } from '@shared/project-dashboard'
import { Tip } from '@/components/ui/tooltip'
import MoreRows from './MoreRows.vue'
import SectionCard from './SectionCard.vue'
import { barWidth, fmt } from './format'
import { ICON } from './icons'

// A total split by where it came from, largest first: each part's icon, its name, a bar on one scale and its count.
const props = defineProps<{ section: FilledSection; data: BreakdownData }>()
const open = ref(false)
const parts = computed(() => [...props.data.rows].sort((a, b) => b.value - a.value))
const rows = computed(() => (open.value ? parts.value : parts.value.slice(0, props.section.show)))
const max = computed(() => Math.max(1, ...parts.value.map((r) => r.value)))
const total = computed(() => parts.value.reduce((n, r) => n + r.value, 0))
</script>

<template>
  <SectionCard :title="section.title" :icon="ICON[section.icon]" :empty="parts.length ? null : 'Nothing counted yet'">
    <template v-if="parts.length" #meta><span :title="data.note">{{ fmt(total) }} in all</span></template>
    <ul class="divide-y divide-border border-t border-border">
      <li v-for="(r, i) in rows" :key="`${i}-${r.label}`" class="flex min-h-9 items-center gap-2.5 px-4 py-1.5">
        <component :is="ICON[r.icon ?? section.icon]" class="size-3.5 shrink-0 text-text-2" aria-hidden="true" />
        <Tip :label="r.note ?? ''" :disabled="!r.note">
          <span class="min-w-0 flex-1 truncate text-ui leading-5 text-text">{{ r.label }}</span>
        </Tip>
        <span class="h-1.5 w-[32%] max-w-48 shrink-0 overflow-hidden rounded-full bg-fill-5" aria-hidden="true">
          <span class="block h-full rounded-full bg-accent" :style="{ width: barWidth(r.value, max) }" />
        </span>
        <span class="w-9 shrink-0 text-end text-ui-sm leading-4 text-text-2 tnum">{{ fmt(r.value) }}</span>
      </li>
    </ul>
    <MoreRows :hidden="parts.length - section.show" :open="open" @toggle="open = !open" />
  </SectionCard>
</template>

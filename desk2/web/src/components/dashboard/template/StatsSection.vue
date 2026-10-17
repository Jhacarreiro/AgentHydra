<script setup lang="ts">
import { ArrowDownRight, ArrowUpRight } from '@lucide/vue'
import type { RangeId, StatsData } from '@shared/project-dashboard'
import StatTile from '@/components/servers/info/kit/StatTile.vue'
import { changeText, tileValue, VS } from './format'
import { ICON } from './icons'

// The headline numbers: one tile each, its change against the window before under it. A number that was not measured
// is a dash, and its tooltip says why.
defineProps<{ data: StatsData; range: RangeId | null }>()
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2" role="group">
    <StatTile v-for="(t, i) in data.tiles" :key="`${t.label}-${i}`" :label="t.label" :value="tileValue(t)" :icon="t.icon ? ICON[t.icon] : undefined" :title="t.note">
      <template v-if="changeText(t.change)" #sub>
        <span class="inline-flex items-center gap-1">
          <component :is="(t.change ?? 0) >= 0 ? ArrowUpRight : ArrowDownRight" class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="tnum">{{ changeText(t.change) }}</span>
          <span v-if="range">{{ VS[range] }}</span>
        </span>
      </template>
    </StatTile>
  </div>
</template>

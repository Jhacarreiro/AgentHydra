<script setup lang="ts">
import { computed, ref } from 'vue'
import { Bug, ChevronDown } from '@lucide/vue'
import type { ErrorsData, FilledSection } from '@shared/project-dashboard'
import { chip } from '@/components/servers/info/kit/kit'
import MoreRows from './MoreRows.vue'
import SectionCard from './SectionCard.vue'
import { barWidth, fmt } from './format'
import { ICON } from './icons'

// Errors grouped by what they say, most frequent first: the message, where it happens, a bar on one scale and its count.
// A row opens in place on its kind, page and severity. The heading's badge counts the open ones, red while any are.
const props = defineProps<{ section: FilledSection; data: ErrorsData }>()
const open = ref(false)
const expanded = ref<number | null>(null)
const groups = computed(() => [...props.data.groups].sort((a, b) => b.count - a.count))
const rows = computed(() => (open.value ? groups.value : groups.value.slice(0, props.section.show)))
const max = computed(() => Math.max(1, ...groups.value.map((g) => g.count)))
const toggle = (i: number) => (expanded.value = expanded.value === i ? null : i)
</script>

<template>
  <SectionCard :title="section.title" :icon="ICON[section.icon]" :empty="groups.length ? null : 'No errors'">
    <template v-if="data.open !== undefined" #meta>
      <span v-if="data.open === null" :title="data.note">– open</span>
      <span v-else :class="data.open > 0 ? chip('danger') : chip('neutral')" :title="data.note">{{ fmt(data.open) }} open</span>
    </template>
    <ul class="divide-y divide-border border-t border-border">
      <li v-for="(g, i) in rows" :key="`${i}-${g.message}`">
        <button type="button" class="flex min-h-9 w-full cursor-default items-center gap-2.5 px-4 py-1.5 text-start hover:bg-fill-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none" :aria-expanded="expanded === i" @click="toggle(i)">
          <Bug class="size-3.5 shrink-0 text-danger-text" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-ui leading-5 text-text" :title="g.message">{{ g.message }}</span>
          <span v-if="g.source" class="hidden max-w-40 shrink-0 truncate text-ui-sm leading-4 text-text-muted sm:block">{{ g.source }}</span>
          <span class="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-fill-5 min-[480px]:block" aria-hidden="true">
            <span class="block h-full rounded-full bg-danger" :style="{ width: barWidth(g.count, max) }" />
          </span>
          <span class="w-9 shrink-0 text-end text-ui-sm leading-4 text-text-2 tnum">{{ fmt(g.count) }}</span>
          <ChevronDown class="size-3.5 shrink-0 text-text-muted transition-transform duration-150" :class="expanded === i && 'rotate-180'" aria-hidden="true" />
        </button>
        <dl v-if="expanded === i" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 pb-3 ps-10 text-ui-sm leading-4.5">
          <dt class="text-text-muted">Message</dt>
          <dd class="min-w-0 wrap-break-word text-text-2">{{ g.message }}</dd>
          <template v-if="g.source"><dt class="text-text-muted">Where</dt><dd class="min-w-0 truncate text-text-2">{{ g.source }}</dd></template>
          <template v-if="g.kind"><dt class="text-text-muted">Kind</dt><dd class="min-w-0 truncate text-text-2">{{ g.kind }}</dd></template>
          <template v-if="g.path"><dt class="text-text-muted">Page</dt><dd class="min-w-0 truncate font-mono text-text-2">{{ g.path }}</dd></template>
          <template v-if="g.severity"><dt class="text-text-muted">Severity</dt><dd class="text-text-2">{{ g.severity }}</dd></template>
          <template v-if="g.href"><dt class="text-text-muted">Open</dt><dd><a :href="g.href" target="_blank" rel="noopener" class="text-accent-text hover:underline">Details</a></dd></template>
        </dl>
      </li>
    </ul>
    <MoreRows :hidden="groups.length - section.show" :open="open" @toggle="open = !open" />
  </SectionCard>
</template>

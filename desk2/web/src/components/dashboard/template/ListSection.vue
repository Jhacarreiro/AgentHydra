<script setup lang="ts">
import { computed, ref } from 'vue'
import { Play } from '@lucide/vue'
import type { FilledSection, ListData } from '@shared/project-dashboard'
import { Tip } from '@/components/ui/tooltip'
import MoreRows from './MoreRows.vue'
import SectionCard from './SectionCard.vue'
import { age, fmt } from './format'
import { ICON } from './icons'

// Things waiting, oldest first: each row its title (two lines at most, the rest in its tooltip), a priority meter when
// the source ranks them, a play mark on one someone is on, and how long it has waited. The heading counts them, or says
// "15 of 337" when the source sent only the first of many.
const props = defineProps<{ section: FilledSection; data: ListData; now: number }>()
const open = ref(false)
const ranked = computed(() => props.data.items.some((i) => i.priority != null))
const rows = computed(() => (open.value ? props.data.items : props.data.items.slice(0, props.section.show)))
const count = computed(() => {
  const n = props.data.items.length
  const total = props.data.total ?? n
  return total > n ? `${fmt(n)} of ${fmt(total)}` : n ? fmt(n) : ''
})
const tipOf = (i: ListData['items'][number]): string => [i.title, i.tags?.length ? i.tags.map((t) => `#${t}`).join(' ') : '', i.note ?? ''].filter(Boolean).join('\n')
const LEVEL: Record<number, string> = { 1: 'Most urgent', 2: 'High', 3: 'Medium', 4: 'Low' }
</script>

<template>
  <SectionCard :title="section.title" :icon="ICON[section.icon]" :dot="section.attention && data.items.length > 0" :empty="data.items.length ? null : 'Nothing waiting'">
    <template v-if="count" #meta>{{ count }}</template>
    <ul class="divide-y divide-border border-t border-border">
      <li v-for="(item, i) in rows" :key="`${i}-${item.title}`" class="flex min-h-9 items-center gap-2.5 px-4 py-1.5">
        <Tip v-if="ranked" :label="item.priority ? `Priority: ${LEVEL[item.priority]}` : 'Not ranked yet'">
          <span class="flex h-3.5 shrink-0 items-end gap-0.5" :aria-label="item.priority ? `Priority ${LEVEL[item.priority]}` : 'Not ranked'">
            <b v-for="j in 4" :key="j" class="w-0.75 rounded-[1px]" :class="item.priority && 5 - item.priority >= j ? 'bg-accent' : 'bg-fill-selected'" :style="{ height: `${3 + j * 2.5}px` }" />
          </span>
        </Tip>
        <Tip :label="tipOf(item)" :delay="600">
          <a v-if="item.href" :href="item.href" target="_blank" rel="noopener" class="line-clamp-2 min-w-0 flex-1 text-ui leading-5 text-text hover:underline">{{ item.title }}</a>
          <span v-else class="line-clamp-2 min-w-0 flex-1 text-ui leading-5 text-text">{{ item.title }}</span>
        </Tip>
        <Tip v-if="item.active" label="Someone is on it">
          <Play class="size-3.5 shrink-0 text-success-text" aria-label="Someone is on it" />
        </Tip>
        <span class="w-10 shrink-0 text-end text-ui-sm leading-4 text-text-muted tnum">{{ age(item.since, now) }}</span>
      </li>
    </ul>
    <MoreRows :hidden="data.items.length - section.show" :open="open" @toggle="open = !open" />
  </SectionCard>
</template>

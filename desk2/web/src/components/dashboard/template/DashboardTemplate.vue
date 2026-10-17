<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Clock, TriangleAlert } from '@lucide/vue'
import { forRange, isMissing, RANGE_LABEL, type BreakdownData, type ErrorsData, type ListData, type ProjectDashboard, type RangeId, type StatsData } from '@shared/project-dashboard'
import Segmented from '@/components/servers/info/kit/Segmented.vue'
import { Tip } from '@/components/ui/tooltip'
import BreakdownSection from './BreakdownSection.vue'
import ErrorsSection from './ErrorsSection.vue'
import ListSection from './ListSection.vue'
import SectionCard from './SectionCard.vue'
import StatsSection from './StatsSection.vue'
import { freshness } from './format'
import { ICON } from './icons'

// A project's dashboard drawn from the template: how fresh its numbers are and the range they cover on one line, then
// each section of its spec in order. A section with no data says why in one line; a range picks every ranged
// section's numbers at once.
const props = defineProps<{ dashboard: ProjectDashboard; now: number }>()

const RANGE_KEY = 'agenthydra.dashboard.range'
const saved = localStorage.getItem(RANGE_KEY) as RangeId | null
const range = ref<RangeId | null>(null)
watch(
  () => props.dashboard.ranges,
  (ranges) => {
    if (range.value && ranges.includes(range.value)) return
    range.value = saved && ranges.includes(saved) ? saved : ranges.includes('7d') ? '7d' : (ranges[0] ?? null)
  },
  { immediate: true }
)
const pick = (r: RangeId) => {
  range.value = r
  localStorage.setItem(RANGE_KEY, r)
}
const options = computed(() => props.dashboard.ranges.map((r) => ({ value: r, label: RANGE_LABEL[r] })))
const fresh = computed(() => freshness(props.dashboard, props.now))
const reading = computed(() => props.dashboard.sources.some((s) => s.reading))

/** Each section with what it shows for the range: its data, or the line that says why there is none. */
const shown = computed(() =>
  props.dashboard.sections.map((s) => {
    const got = s.feed ? forRange(s.feed, range.value ?? 'today') : null
    const empty = s.missing ?? (isMissing(got) ? got.missing : !s.feed ? (reading.value ? 'Reading…' : 'Waiting for its source') : !got ? `No numbers for ${RANGE_LABEL[range.value ?? 'today']}` : null)
    return { s, data: empty ? null : (got as StatsData | ListData | ErrorsData | BreakdownData), empty }
  })
)
const problemsOpen = ref(false)
</script>

<template>
  <div class="mx-auto flex w-full max-w-[960px] flex-col gap-3 px-4 pt-1 pb-8 sm:px-6" data-testid="dashboard-template">
    <div class="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <Tip :label="fresh.tip" :disabled="!fresh.tip">
        <span class="inline-flex min-w-0 items-center gap-1.5 text-ui-sm leading-4" :class="fresh.late ? 'text-warning-text' : 'text-text-muted'" data-testid="dashboard-fresh">
          <component :is="fresh.late ? TriangleAlert : Clock" class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="truncate">{{ fresh.text || (reading ? 'Reading…' : 'Not read yet') }}</span>
        </span>
      </Tip>
      <Segmented v-if="range && options.length > 1" :model-value="range" :options="options" label="Period" @update:model-value="pick" />
    </div>

    <div v-if="dashboard.problems.length" class="rounded-(--radius-10) bg-[color-mix(in_srgb,var(--warning-bg)_70%,transparent)] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warning)_30%,transparent)]">
      <button type="button" class="flex w-full cursor-default items-center gap-2 text-start text-ui leading-5 font-medium text-warning-text" :aria-expanded="problemsOpen" @click="problemsOpen = !problemsOpen">
        <TriangleAlert class="size-4 shrink-0" aria-hidden="true" />
        <span class="flex-1">{{ dashboard.problems.length }} {{ dashboard.problems.length === 1 ? 'problem' : 'problems' }} in the dashboard spec</span>
      </button>
      <ul v-if="problemsOpen" class="mt-1.5 flex flex-col gap-1 ps-6 text-ui-sm leading-4.5 text-text-2">
        <li v-for="(p, i) in dashboard.problems" :key="i" class="wrap-break-word">{{ p }}</li>
      </ul>
    </div>

    <template v-for="{ s, data, empty } in shown" :key="s.id">
      <template v-if="s.type === 'stats'">
        <StatsSection v-if="data" :data="data as StatsData" :range="dashboard.ranges.length ? range : null" />
        <SectionCard v-else :title="s.title" :icon="ICON[s.icon]" :empty="empty" />
      </template>
      <SectionCard v-else-if="!data" :title="s.title" :icon="ICON[s.icon]" :empty="empty" />
      <ListSection v-else-if="s.type === 'list'" :section="s" :data="data as ListData" :now="now" />
      <ErrorsSection v-else-if="s.type === 'errors'" :section="s" :data="data as ErrorsData" />
      <BreakdownSection v-else :section="s" :data="data as BreakdownData" />
    </template>
  </div>
</template>

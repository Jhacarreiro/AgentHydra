<script setup lang="ts">
import { computed } from 'vue'
import { Check, ExternalLink } from '@lucide/vue'
import type { DashboardTone, DashboardWidget } from '@shared/dashboards'
import { renderMarkdown } from '@/components/transcript/lib/markdown'
import { chartGeometry, isWebLink, progressPercent, timeAgo } from './logic'

const props = defineProps<{ widget: DashboardWidget; now: number; span: number }>()
const emit = defineEmits<{ remove: [id: string]; link: [href: string] }>()

const TONE_TEXT: Record<DashboardTone, string> = {
  good: 'text-(--success-text)',
  bad: 'text-(--danger-text)',
  warn: 'text-(--warning-text)',
  neutral: 'text-text-2'
}
const TONE_PILL: Record<DashboardTone, string> = {
  good: 'bg-(--success-bg) text-(--success-text)',
  bad: 'bg-(--danger-bg) text-(--danger-text)',
  warn: 'bg-(--warning-bg) text-(--warning-text)',
  neutral: 'bg-(--fill-secondary) text-text-2'
}
const TONE_DOT: Record<DashboardTone, string> = {
  good: 'bg-(--success-text)',
  bad: 'bg-(--danger-text)',
  warn: 'bg-(--warning-text)',
  neutral: 'bg-text-muted'
}
const tone = (t: DashboardTone | undefined): DashboardTone => t ?? 'neutral'

const percent = computed(() => progressPercent(props.widget.current, props.widget.max))
const chart = computed(() => (props.widget.kind === 'chart' ? chartGeometry(props.widget.series ?? [], 600, 160) : null))
const noteHtml = computed(() => (props.widget.kind === 'note' ? renderMarkdown(props.widget.text ?? '') : ''))
const ago = computed(() => timeAgo(props.widget.updatedAt, props.now))
const legend = computed(() => (props.widget.series ?? []).map((s, i) => ({ label: s.label, color: chart.value?.lines[i]?.color })).filter((s) => s.label))
</script>

<template>
  <article
    class="group/card flex min-w-0 flex-col gap-3 rounded-(--radius-12) bg-fill-5 p-4"
    :style="{ gridColumn: `span ${span}` }"
    :data-kind="widget.kind"
    :aria-label="widget.title"
  >
    <h3 class="truncate text-[13px] leading-4.75 font-medium text-text-muted">{{ widget.title }}</h3>

    <template v-if="widget.kind === 'stat'">
      <div class="flex items-baseline gap-1.5">
        <span class="text-[32px] leading-9 font-semibold tracking-tight text-text tabular-nums">{{ widget.value ?? '—' }}</span>
        <span v-if="widget.unit" class="text-[14px] leading-5 text-text-muted">{{ widget.unit }}</span>
      </div>
      <div v-if="widget.delta || widget.caption" class="flex flex-wrap items-center gap-2">
        <span v-if="widget.delta" :class="['rounded-(--radius-5) px-1.5 text-[11px] leading-4 font-semibold tabular-nums', TONE_PILL[tone(widget.tone)]]">{{ widget.delta }}</span>
        <span v-if="widget.caption" class="text-[12px] leading-4 text-text-muted">{{ widget.caption }}</span>
      </div>
    </template>

    <ul v-else-if="widget.kind === 'list'" class="flex flex-col gap-1.5">
      <li v-for="(item, i) in widget.items ?? []" :key="i" class="flex min-w-0 items-start gap-2.5">
        <span :class="['mt-1.5 size-1.5 shrink-0 rounded-full', TONE_DOT[tone(item.tone)]]" aria-hidden="true" />
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 items-center gap-1.5">
            <span v-if="item.done" class="flex size-3.5 shrink-0 items-center justify-center rounded-[4px] bg-(--fill-secondary) text-text-2" aria-label="Done">
              <Check class="size-2.5" aria-hidden="true" />
            </span>
            <span :class="['min-w-0 truncate text-[13px] leading-5', item.done ? 'text-text-muted line-through' : 'text-text']">{{ item.text }}</span>
            <button
              v-if="item.href"
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded-(--radius-5) bg-(--fill-secondary) px-1.5 text-[11px] leading-4 text-text-2 hover:text-text"
              :aria-label="`Open ${item.text}`"
              @click="emit('link', item.href)"
            >
              <ExternalLink class="size-3" aria-hidden="true" />
              {{ isWebLink(item.href) ? 'Open' : 'Reveal' }}
            </button>
          </span>
          <span v-if="item.detail" class="truncate font-mono text-[11px] leading-4 text-text-muted">{{ item.detail }}</span>
        </span>
      </li>
      <li v-if="!(widget.items ?? []).length" class="text-[12px] leading-4 text-text-muted">Nothing listed.</li>
    </ul>

    <div
      v-else-if="widget.kind === 'note'"
      class="text-[13px] leading-5 text-text-2 [&_code]:font-mono [&_code]:text-[12px] [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:ps-4"
      v-html="noteHtml"
    />

    <div v-else-if="widget.kind === 'progress'" class="flex flex-col gap-2">
      <div class="flex items-baseline justify-between gap-2 text-[12px] leading-4 text-text-2 tabular-nums">
        <span>{{ widget.current ?? 0 }} of {{ widget.max ?? 0 }}{{ widget.unit ? ` ${widget.unit}` : '' }}</span>
        <span class="font-semibold">{{ percent }}%</span>
      </div>
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-(--fill-secondary)" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
        <div :class="['h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none', tone(widget.tone) === 'neutral' ? 'bg-(--accent)' : TONE_DOT[tone(widget.tone)]]" :style="{ width: `${percent}%` }" />
      </div>
      <p v-if="widget.caption" class="text-[12px] leading-4 text-text-muted">{{ widget.caption }}</p>
    </div>

    <div v-else-if="widget.kind === 'chart' && chart" class="flex flex-col gap-2">
      <div class="flex gap-2">
        <div class="flex flex-col justify-between py-0.5 text-right text-[10px] leading-3 text-text-muted tabular-nums">
          <span>{{ chart.yMax }}</span>
          <span>{{ chart.yMin }}</span>
        </div>
        <svg viewBox="0 0 600 160" preserveAspectRatio="none" class="h-40 min-w-0 flex-1 overflow-visible" role="img" :aria-label="widget.title">
          <path v-if="chart.area" :d="chart.area" fill="var(--accent-text)" fill-opacity="0.14" />
          <path v-for="(line, i) in chart.lines" :key="i" :d="line.d" fill="none" :stroke="line.color" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        </svg>
      </div>
      <div v-if="widget.labels?.length" class="ps-7 flex justify-between text-[10px] leading-3 text-text-muted">
        <span v-for="(l, i) in widget.labels" :key="i">{{ l }}</span>
      </div>
      <div v-if="legend.length" class="flex flex-wrap gap-3 text-[11px] leading-4 text-text-2">
        <span v-for="(s, i) in legend" :key="i" class="inline-flex items-center gap-1.5">
          <span class="size-2 rounded-full" :style="{ background: s.color }" aria-hidden="true" />{{ s.label }}
        </span>
      </div>
    </div>

    <div class="mt-auto flex items-center justify-between gap-2 pt-1 text-[11px] leading-4 text-text-muted">
      <span class="min-w-0 truncate">by {{ widget.updatedBy }}<template v-if="ago"> · {{ ago }}</template></span>
      <button
        type="button"
        class="shrink-0 rounded-(--radius-5) px-1.5 text-text-muted opacity-0 transition-opacity duration-100 group-hover/card:opacity-100 focus-visible:opacity-100 hover:text-danger"
        :aria-label="`Remove ${widget.title}`"
        @click="emit('remove', widget.id)"
      >
        Remove
      </button>
    </div>
  </article>
</template>

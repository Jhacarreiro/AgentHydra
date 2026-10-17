<script setup lang="ts">
// The run history of one routine: a bar per run (height is its duration; green ok, red failed, amber busy; newest last),
// the counts as a legend, then the run list. Pages come from GET /api/routines/:id/details; 'Load more' asks for the next.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleX, Clock, MessageSquare } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { openInDesk } from '@/lib/desk-embed'
import type { RoutineDetailsStats, RoutineOutcome, RoutineRun } from '@desk/shared/routines'
import { durationText, relativeTime } from '@/lib/routine-words'

const props = defineProps<{
  runs: RoutineRun[]
  stats: RoutineDetailsStats | null
  nextBefore: number | null
  busy: boolean
  now: number
}>()
const emit = defineEmits<{ more: [] }>()
const { t } = useI18n()

type Kind = 'ok' | 'failed' | 'busy'
const kindOf = (o: RoutineOutcome): Kind => (o === 'ok' ? 'ok' : o === 'busy' ? 'busy' : 'failed')
const BAR: Record<Kind, string> = { ok: 'bg-success', failed: 'bg-destructive', busy: 'bg-warning' }
const durationOf = (r: RoutineRun): number => Math.max(0, r.endedAt - r.startedAt)

// The newest 60 of the page, oldest on the left. A failed bar keeps a visible minimum height, so a short failure still shows.
const bars = computed(() => {
  const shown = props.runs.slice(0, 60).reverse()
  const max = Math.max(1, ...shown.map(durationOf))
  return shown.map((r) => {
    const kind = kindOf(r.outcome)
    const floor = kind === 'failed' ? 20 : 8
    return {
      key: `${r.startedAt}`,
      kind,
      height: Math.max(floor, Math.round((durationOf(r) / max) * 100)),
      title: `${relativeTime(r.endedAt, props.now)}, ${durationText(durationOf(r))}`,
    }
  })
})

// What a run says on its line: its AI description when it has one, else the last line it printed.
function lineOf(r: RoutineRun): string {
  if (r.description?.state === 'done') return r.description.text
  if (r.description?.state === 'pending') return t('routines.describing')
  if (r.description?.state === 'failed') return t('routines.describeFailed')
  return r.lastLine || '-'
}

function openRun(r: RoutineRun) {
  if (r.sessionId) openInDesk({ session_id: r.sessionId, source: 'claude' })
}
</script>

<template>
  <section class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-ui font-medium">{{ t('routines.history') }}</h3>
      <div v-if="stats" class="flex items-center gap-3 text-2xs text-muted-foreground tabular-nums">
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-full bg-success" aria-hidden="true" />{{ t('routines.okCount', { n: stats.ok }) }}</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-full bg-destructive" aria-hidden="true" />{{ t('routines.failedCount', { n: stats.failed }) }}</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-full bg-warning" aria-hidden="true" />{{ t('routines.busyCount', { n: stats.busy }) }}</span>
      </div>
    </div>

    <div v-if="bars.length" class="flex h-20 items-end gap-0.5" role="img" :aria-label="t('routines.history')">
      <span
        v-for="b in bars"
        :key="b.key"
        class="min-w-1 flex-1 rounded-t-sm"
        :class="BAR[b.kind]"
        :style="{ height: `${b.height}%` }"
        :title="b.title"
      />
    </div>

    <p v-if="!runs.length" class="text-ui text-muted-foreground">{{ t('routines.noRuns') }}</p>

    <ul v-else class="flex flex-col">
      <li
        v-for="r in runs"
        :key="`${r.startedAt}:${r.endedAt}`"
        class="flex min-h-8 items-center gap-2 border-b border-border py-1 text-ui last:border-b-0"
      >
        <CircleCheck v-if="kindOf(r.outcome) === 'ok'" class="size-3.5 shrink-0 text-success" aria-hidden="true" />
        <CircleX v-else-if="kindOf(r.outcome) === 'failed'" class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <Clock v-else class="size-3.5 shrink-0 text-warning" aria-hidden="true" />
        <span class="w-20 shrink-0 text-muted-foreground tabular-nums" :title="new Date(r.endedAt).toLocaleString()">{{ relativeTime(r.endedAt, now) }}</span>
        <span class="w-16 shrink-0 tabular-nums">{{ durationText(durationOf(r)) }}</span>
        <span class="min-w-0 flex-1 truncate" :class="r.description?.state === 'done' ? '' : 'text-muted-foreground'">{{ lineOf(r) }}</span>
        <Button
          v-if="r.sessionId"
          size="icon"
          variant="ghost"
          class="size-7 shrink-0"
          :aria-label="t('routines.openRunChat')"
          :title="t('routines.openRunChat')"
          @click="openRun(r)"
        >
          <MessageSquare />
        </Button>
      </li>
    </ul>

    <div v-if="nextBefore !== null" class="flex justify-center">
      <Button size="sm" variant="outline" :disabled="busy" @click="emit('more')">{{ t('routines.loadMore') }}</Button>
    </div>
  </section>
</template>

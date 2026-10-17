<script setup lang="ts">
// The campaigns a routine works for (its `campaigns` key), from GET /api/routines/:id/campaigns: per campaign one block
// with its status, a stacked bar of what was sent, Ready (next up), its last run, and one tap deeper for its now, next
// and newest runs. The do-not-contact list is shared by every campaign, so it is labelled board-wide.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, Megaphone } from '@lucide/vue'
import type { CampaignLedger, RoutineCampaigns } from '@desk/shared/routines'
import { relativeTime } from '@/lib/routine-words'

const props = defineProps<{ data: RoutineCampaigns | null; error: string | null; now: number }>()
const { t } = useI18n()

// Which campaigns are opened one tap deeper (their now, next and newest runs). Opened by id, so a refresh keeps them.
const opened = ref<string[]>([])
const isOpen = (id: string) => opened.value.includes(id)
function toggle(id: string) {
  opened.value = isOpen(id) ? opened.value.filter((x) => x !== id) : [...opened.value, id]
}

// The stacked bar: of what was sent, the replied, bounced and opted-out parts, the rest in grey.
function parts(c: CampaignLedger) {
  const n = c.numbers
  if (!n || n.sent <= 0) return null
  const replied = Math.min(n.replied, n.sent)
  const bounced = Math.min(n.bounced, n.sent - replied)
  const optedOut = Math.min(n.optedOut, n.sent - replied - bounced)
  const rest = n.sent - replied - bounced - optedOut
  const pct = (x: number) => `${(x / n.sent) * 100}%`
  return [
    { key: 'replied', tone: 'bg-success', width: pct(replied) },
    { key: 'bounced', tone: 'bg-destructive', width: pct(bounced) },
    { key: 'optedOut', tone: 'bg-muted-foreground/60', width: pct(optedOut) },
    { key: 'rest', tone: 'bg-muted', width: pct(rest) },
  ]
}

const PILL: Record<string, string> = {
  running: 'bg-success/15 text-success',
}
const pillOf = (status: string) => PILL[status] ?? 'bg-muted text-muted-foreground'
const word = (status: string) => (status ? status.charAt(0).toUpperCase() + status.slice(1) : '')

const missing = computed(() => props.data?.missing ?? [])
</script>

<template>
  <section class="flex flex-col gap-2">
    <h3 class="flex items-center gap-1.5 text-ui font-medium">
      <Megaphone class="size-3.5 text-muted-foreground" aria-hidden="true" />{{ t('routines.campaigns') }}
    </h3>

    <p v-if="error" class="text-ui text-muted-foreground">{{ t('routines.campaignsError', { reason: error }) }}</p>

    <template v-else-if="data">
      <article
        v-for="c in data.campaigns"
        :key="c.id"
        class="flex flex-col gap-2 rounded-md bg-muted/40 p-3"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-ui font-medium">{{ c.name }}</span>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-2xs" :class="pillOf(c.status)">{{ word(c.status) }}</span>
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
            :aria-expanded="isOpen(c.id)"
            @click="toggle(c.id)"
          >
            <component :is="isOpen(c.id) ? ChevronDown : ChevronRight" class="size-3.5" aria-hidden="true" />
            {{ isOpen(c.id) ? t('routines.hideCampaign') : t('routines.showCampaign') }}
          </button>
        </div>

        <div v-if="parts(c)" class="flex h-2 overflow-hidden rounded-full bg-muted" role="img" :aria-label="t('routines.sent')">
          <span v-for="p in parts(c)" :key="p!.key" class="h-full" :class="p!.tone" :style="{ width: p!.width }" />
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground tabular-nums">
          <span>{{ t('routines.sent') }} {{ c.numbers?.sent ?? 0 }}</span>
          <span>{{ t('routines.replied') }} {{ c.numbers?.replied ?? 0 }}</span>
          <span>{{ t('routines.bounced') }} {{ c.numbers?.bounced ?? 0 }}</span>
          <span>{{ t('routines.optedOut') }} {{ c.numbers?.optedOut ?? 0 }}</span>
          <span class="text-foreground">{{ t('routines.ready') }} {{ c.ready ?? '-' }}</span>
          <span v-if="c.runs[0]" :title="c.runs[0].note">
            {{ t('routines.lastCampaignRun') }} {{ relativeTime(c.runs[0].at, now) }}
          </span>
        </div>

        <div v-if="isOpen(c.id)" class="flex flex-col gap-2 border-t border-border pt-2 text-ui">
          <div v-if="c.now.length" class="flex flex-col gap-0.5">
            <span class="text-2xs text-muted-foreground">{{ t('routines.nowLines') }}</span>
            <span v-for="(line, i) in c.now" :key="`now-${i}`">{{ line }}</span>
          </div>
          <div v-if="c.next.length" class="flex flex-col gap-0.5">
            <span class="text-2xs text-muted-foreground">{{ t('routines.nextLines') }}</span>
            <span v-for="(line, i) in c.next" :key="`next-${i}`">{{ line }}</span>
          </div>
          <div v-if="c.runs.length" class="flex flex-col gap-1">
            <span class="text-2xs text-muted-foreground">{{ t('routines.newestRuns') }}</span>
            <div v-for="(run, i) in c.runs" :key="`run-${i}`" class="flex flex-col">
              <span class="text-muted-foreground tabular-nums">{{ relativeTime(run.at, now) }}</span>
              <span class="truncate">{{ run.note }}</span>
              <span v-if="run.problems.length" class="text-destructive">{{ run.problems.join('; ') }}</span>
            </div>
          </div>
        </div>
      </article>

      <p v-if="data.doNotContact !== null" class="text-2xs text-muted-foreground">
        {{ t('routines.doNotContact', { n: data.doNotContact }) }}
      </p>
      <p v-for="id in missing" :key="id" class="text-2xs text-muted-foreground">{{ t('routines.missingCampaign', { id }) }}</p>
    </template>
  </section>
</template>

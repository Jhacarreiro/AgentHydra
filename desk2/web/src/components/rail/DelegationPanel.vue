<script setup lang="ts">
// The Delegation panel the rail slides over its cards, as the Background tasks panel does (owner, 2026-10-15: "a similar simple
// version ... just basic stats on this chat"): per service, its runs, tasks and outcomes, its tokens (an estimate, marked est.),
// then one row per model with its tasks, succeeded and failed. Its back arrow slides the cards back.
// Each service is a card, as the Background tasks panel's units are (owner, 2026-10-15: "it all feels a little cramped ... poorly
// laid out compared to the rest of the app"): its figures as labelled numbers on one aligned grid, how its runs ended, then the
// model table with columns wide enough for their headings.
import { Check, ChevronLeft, Network, Users, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { formatCompact } from '@/components/session-header/logic'
import type { DelegationService, ServiceStats } from './delegation'
import { RAIL_ICON_BTN } from './classes'

defineProps<{ stats: ServiceStats[] }>()
const SERVICE_ICON: Record<DelegationService, typeof Network> = { hswarm: Network, climayte: Users }
const emit = defineEmits<{ back: []; close: [] }>()

// HSwarm's tokens are measured; CliMayte's are an estimate, so their label says so. The cost cell is left empty, not dropped,
// so the two cards' figures stay in the same columns.
const figures = (s: ServiceStats) => [
  { label: s.runs === 1 ? 'Run' : 'Runs', value: s.runs.toLocaleString() },
  { label: s.tasks === 1 ? 'Task' : 'Tasks', value: s.tasks.toLocaleString() },
  { label: s.tokensEst ? 'Tokens est.' : 'Tokens', value: s.tokens === null ? '–' : formatCompact(s.tokens) },
  { label: s.costUsd === null ? '' : 'Cost', value: s.costUsd === null ? '' : `$${s.costUsd.toFixed(2)}` }
]
</script>

<template>
  <section class="flex size-full min-h-0 flex-col overflow-hidden rounded-lg border border-(--border) bg-(--bg-panel) text-ui leading-5" aria-label="Delegation">
    <header class="flex h-8.5 shrink-0 items-center ps-1 pe-1">
      <Tip label="Back to session details" side="bottom">
        <button type="button" :class="RAIL_ICON_BTN" aria-label="Back to session details" @click="emit('back')">
          <ChevronLeft class="size-4" :stroke-width="1.5" />
        </button>
      </Tip>
      <h2 class="min-w-0 flex-1 truncate font-normal text-text-2">Delegation</h2>
      <Tip label="Close" side="bottom">
        <button type="button" :class="RAIL_ICON_BTN" aria-label="Close" @click="emit('close')">
          <X class="size-3.5" :stroke-width="1.75" />
        </button>
      </Tip>
    </header>
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-1.5">
      <article v-for="s in stats" :key="s.service" class="rounded-lg bg-fill-5 p-3" :aria-label="s.label" :data-testid="`delegation-${s.service}`">
        <h3 class="flex h-5 items-center gap-2 font-medium text-text">
          <component :is="SERVICE_ICON[s.service]" class="size-4 shrink-0 text-text-2" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ s.label }}</span>
        </h3>

        <dl class="mt-3 grid grid-cols-4 gap-x-2">
          <div v-for="f in figures(s)" :key="f.label" class="flex min-w-0 flex-col">
            <dt class="truncate text-2xs leading-4 text-text-muted">{{ f.label }}</dt>
            <dd class="tnum truncate text-ui-lg font-semibold leading-5 text-text">{{ f.value }}</dd>
          </div>
        </dl>

        <p class="tnum mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ui-sm text-text-muted">
          <span v-if="s.succeeded" class="flex items-center gap-1">
            <Check class="size-3 shrink-0" :stroke-width="1.75" aria-hidden="true" />{{ s.succeeded.toLocaleString() }} succeeded
          </span>
          <span v-if="s.failed" class="flex items-center gap-1 text-danger-text">
            <X class="size-3 shrink-0" :stroke-width="1.75" aria-hidden="true" />{{ s.failed.toLocaleString() }} failed
          </span>
          <span v-if="s.running" class="flex items-center gap-1 text-text-2">
            <span class="size-1.5 shrink-0 animate-(--animate-dot-blink) rounded-full bg-(--accent)" aria-hidden="true" />{{ s.running.toLocaleString() }} running
          </span>
        </p>

        <table v-if="s.models.length" class="tnum mt-3 w-full table-fixed border-collapse">
          <thead>
            <tr class="h-6 border-b border-(--border) text-ui-sm text-text-muted">
              <th class="p-0 text-start font-normal">Model</th>
              <th class="w-11 p-0 ps-2 text-end font-normal">Tasks</th>
              <th class="w-18 p-0 ps-2 text-end font-normal">Succeeded</th>
              <th class="w-12 p-0 ps-2 text-end font-normal">Failed</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in s.models" :key="m.model" class="h-6.5">
              <td class="truncate p-0 text-text">{{ m.model }}</td>
              <td class="p-0 ps-2 text-end text-text-2">{{ m.tasks.toLocaleString() }}</td>
              <td class="p-0 ps-2 text-end text-text-2">{{ m.succeeded.toLocaleString() }}</td>
              <td class="p-0 ps-2 text-end" :class="m.failed ? 'text-danger-text' : 'text-text-muted'">{{ m.failed.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </article>
      <p v-if="!stats.length" class="py-6 text-center text-text-muted">Nothing delegated in this chat</p>
    </div>
  </section>
</template>

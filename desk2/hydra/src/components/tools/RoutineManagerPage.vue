<script setup lang="ts">
// The Routine manager's page (Tools > Managers): whether it runs, when it last looked and looks next, the central store
// it reads, and the proposals waiting for a yes. Read-only; a proposal opens its own page through select.
import type { RoutinesStatus } from '@desk/shared/routines'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MANAGER_DOT_CLASS, MANAGER_TEXT_CLASS, managerDot } from '@/lib/managers'
import { durationText, exactTime, relativeTime } from '@/lib/routine-words'

const props = defineProps<{ routines: RoutinesStatus | null; now: number }>()

const emit = defineEmits<{ select: [key: string] }>()

const { t } = useI18n()

const dot = computed(() => (props.routines ? managerDot(props.routines.enabled, !!props.routines.error || !!props.routines.store?.error) : undefined))

const word = computed(() => {
  if (dot.value === undefined) return t('tools.routineManager.notRead')
  if (dot.value === 'bad') return t('tools.routineManager.problem')
  return dot.value === 'ok' ? t('tools.routineManager.on') : t('tools.routineManager.off')
})

const lastLook = computed(() => {
  const at = props.routines?.checkedAt ?? null
  return at === null ? t('tools.routineManager.noLook') : `${t('tools.routineManager.lastLook')} ${relativeTime(at, props.now)}`
})

const nextLook = computed(() => {
  const at = props.routines?.nextCheckAt ?? null
  // relativeTime words a past instant as 'ago' and a look under a minute away as 'just now', so both read as due.
  if (at === null) return ''
  if (at - props.now < 60_000) return t('tools.routineManager.dueNow')
  return `${t('tools.routineManager.nextLook')} ${relativeTime(at, props.now)}`
})

const counts = computed(() => {
  const list = props.routines?.routines ?? []
  return t('tools.routineManager.routines.counts', {
    total: list.length,
    running: list.filter((r) => r.state === 'running').length,
    paused: list.filter((r) => r.paused || r.state === 'paused').length,
  })
})

const store = computed(() => props.routines?.store ?? null)
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-4 p-4">
    <header class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h1 tabindex="-1" class="text-ui font-medium focus-visible:outline-2 focus-visible:outline-primary">{{ t('tools.routineManager.title') }}</h1>
        <span class="flex items-center gap-1.5 text-2xs" :class="MANAGER_TEXT_CLASS[dot ?? 'off']">
          <span aria-hidden="true" class="size-2 rounded-full" :class="MANAGER_DOT_CLASS[dot ?? 'off']"></span>
          {{ word }}
        </span>
      </div>
      <p class="text-ui text-muted-foreground">{{ t('tools.routineManager.caption') }}</p>
      <p class="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
        <span :title="exactTime(routines?.checkedAt ?? null)">{{ lastLook }}</span>
        <span v-if="nextLook" :title="exactTime(routines?.nextCheckAt ?? null)">{{ nextLook }}</span>
        <span v-if="routines">{{ t('tools.routineManager.looksEvery', { when: durationText(routines.everyMs) }) }}</span>
      </p>
      <p v-if="routines" class="text-2xs text-muted-foreground">{{ counts }}</p>
      <p v-if="routines?.error" class="text-ui text-destructive">{{ t('tools.routineManager.readError', { reason: routines.error }) }}</p>
    </header>

    <section aria-labelledby="routine-proposals" class="flex flex-col gap-2">
      <h2 id="routine-proposals" class="text-ui font-medium">{{ t('tools.routineManager.proposals.title') }}</h2>
      <p v-if="!routines?.proposals.length" class="text-ui text-muted-foreground">{{ t('tools.routineManager.proposals.none') }}</p>
      <ul v-else role="list" class="flex flex-col gap-1.5">
        <li v-for="p in routines.proposals" :key="p.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-start text-ui focus-visible:outline-2 focus-visible:outline-primary"
            :aria-label="t('tools.routineManager.proposals.open', { name: p.name })"
            @click="emit('select', `p:${p.id}`)"
          >
            <span class="min-w-0 flex-1 truncate font-medium">{{ p.name }}</span>
            <span class="text-2xs text-warning">{{ t('tools.routineManager.proposals.waiting') }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section aria-labelledby="routine-store" class="flex flex-col gap-2">
      <h2 id="routine-store" class="text-ui font-medium">{{ t('tools.routineManager.store.title') }}</h2>
      <p v-if="!store" class="text-ui text-muted-foreground">{{ t('tools.routineManager.store.none') }}</p>
      <div v-else class="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-ui">
        <p class="flex flex-wrap gap-x-3">
          <span class="text-muted-foreground">{{ t('tools.routineManager.store.repo') }}</span>
          <span class="break-all">{{ store.repo }}</span>
        </p>
        <p class="flex flex-wrap gap-x-3">
          <span class="text-muted-foreground">{{ t('tools.routineManager.store.runner') }}</span>
          <span class="break-all">{{ store.runner }}</span>
        </p>
        <p v-if="store.readAt !== null" class="text-2xs text-muted-foreground" :title="exactTime(store.readAt)">
          {{ t('tools.routineManager.store.read', { when: relativeTime(store.readAt, now) }) }}
        </p>
        <p v-if="store.error" class="text-destructive">{{ t('tools.routineManager.store.error', { reason: store.error }) }}</p>
        <p v-if="store.runsError" class="text-destructive">{{ t('tools.routineManager.store.runsError', { reason: store.runsError }) }}</p>
        <div v-if="store.problems.length" class="flex flex-col gap-0.5">
          <span class="text-2xs text-muted-foreground">{{ t('tools.routineManager.store.problems') }}</span>
          <span v-for="problem in store.problems" :key="problem.id" class="text-2xs text-destructive">
            {{ t('tools.routineManager.store.problem', { id: problem.id, reason: problem.reason }) }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Cloud, Monitor, RefreshCw } from '@lucide/vue'
import type { PeopleHomeKind, PeopleStoreStatus } from './where-types'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { BUTTON } from '@/components/panes/settings-styles'
import { chooseHome, loadStatus, syncNow } from './where-api'
import { syncLine, whereView } from './where-logic'

// Settings → People → "Where your people live": This PC (the default) or CrAInium (private).
// Its own component and route (/api/people-store), registered once in Settings; the first-run "Your people" page
// is a separate component. CrAInium shows only when this PC can reach it; otherwise This PC is the only choice.
const status = shallowRef<PeopleStoreStatus | null>(null)
const failure = ref<string | null>(null)
const busy = ref<'home' | 'sync' | null>(null)
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

const view = computed(() => (status.value ? whereView(status.value) : null))
// What shows under the controls: a request that failed, else the last sync's own words.
const error = computed(() => failure.value ?? status.value?.error ?? null)
const when = computed(() => (status.value?.lastSyncAt ? new Date(status.value.lastSyncAt).toLocaleString() : ''))

async function run(kind: NonNullable<typeof busy.value>, f: () => Promise<PeopleStoreStatus>) {
  busy.value = kind
  failure.value = null
  try {
    status.value = await f()
  } catch (e) {
    failure.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = null
  }
}

const pick = (home: PeopleHomeKind) => {
  if (status.value?.home !== home) void run('home', () => chooseHome(home))
}

onMounted(async () => {
  try {
    status.value = await loadStatus()
  } catch (e) {
    failure.value = e instanceof Error ? e.message : String(e)
  }
  tick = setInterval(() => (now.value = Date.now()), 30_000)
})
onBeforeUnmount(() => tick && clearInterval(tick))

const SEG = 'flex h-7 cursor-default items-center gap-1.5 rounded-[var(--radius-6)] px-3 text-ui transition-colors duration-[60ms] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50'
const ON = 'bg-accent-bg text-accent font-medium'
const OFF = 'text-text-2 hover:bg-fill-hover'
</script>

<template>
  <div role="group" aria-label="Where your people live" class="mt-8 flex flex-col" data-testid="people-where">
    <h3 class="text-ui font-semibold leading-5 text-text">Where your people live</h3>
    <p v-if="!status && !failure" class="mt-2 text-ui leading-4.75 text-text-muted">Loading…</p>

    <template v-if="status && view">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3.5">
        <div class="min-w-50 flex-1 text-ui leading-5 text-text">Home</div>
        <div role="radiogroup" aria-label="Where your people live" class="flex shrink-0 items-center gap-1 rounded-(--radius-6) bg-fill-5 p-0.5">
          <button type="button" role="radio" :aria-checked="status.home === 'pc'" :class="[SEG, status.home === 'pc' ? ON : OFF]" :disabled="busy !== null" @click="pick('pc')">
            <Monitor class="size-3.5" aria-hidden="true" /> This PC
          </button>
          <button v-if="view.canPick || status.home === 'crainium'" type="button" role="radio" :aria-checked="status.home === 'crainium'" :class="[SEG, status.home === 'crainium' ? ON : OFF]" :disabled="busy !== null || !view.canPick" @click="pick('crainium')">
            <Cloud class="size-3.5" aria-hidden="true" /> CrAInium (private)
          </button>
        </div>
      </div>

      <div v-if="status.home === 'crainium' && !view.canPick && status.crainium.reason" class="border-b border-border py-3.5 text-ui leading-4.75 text-text-muted" data-testid="crainium-away">{{ status.crainium.reason }}</div>

      <div v-if="view.showSync" class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3.5">
        <div class="min-w-50 flex-1 text-ui leading-5 text-text-2" data-testid="sync-line">
          <span :title="when">{{ syncLine(status, now) }}</span>
        </div>
        <button type="button" :class="BUTTON" :disabled="busy !== null || status.syncing" :aria-busy="busy === 'sync' || status.syncing" @click="run('sync', syncNow)">
          <RefreshCw class="me-1.5 size-3.5" :class="busy === 'sync' || status.syncing ? 'animate-spin' : ''" aria-hidden="true" /> Sync now
        </button>
      </div>
    </template>

    <p v-if="error" class="mt-3 text-ui leading-4.75 text-danger-text" role="alert" data-testid="people-where-error">{{ error }}</p>
  </div>
</template>

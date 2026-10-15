<script setup lang="ts">
import { Cloud, LogIn, LogOut, Monitor, RefreshCw } from '@lucide/vue'
import type { PeopleHomeKind, PeopleStoreStatus } from './where-types'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { BUTTON } from '@/components/panes/settings-styles'
import { chooseHome, loadStatus, signIn, signOut, syncNow } from './where-api'
import { initialsOf, syncLine, whereView } from './where-logic'

// Settings → People → "Where your people live": This PC (the default) or the person's Connections account.
// Its own component and route (/api/people-store), registered once in Settings; the first-run "Your people" page
// is a separate component. Connections with no app id in this build says so and This PC keeps working.
const status = shallowRef<PeopleStoreStatus | null>(null)
const failure = ref<string | null>(null)
const busy = ref<'home' | 'signin' | 'signout' | 'sync' | null>(null)
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
const FILLED =
  'flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-[var(--radius-6)] bg-accent px-3 text-ui font-medium text-white transition-opacity duration-[60ms] hover:opacity-90 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50'
</script>

<template>
  <div role="group" aria-label="Where your people live" class="mt-8 flex flex-col" data-testid="people-where">
    <h3 class="text-ui font-semibold leading-5 text-text">Where your people live</h3>
    <p v-if="!status && !failure" class="mt-2 text-ui leading-4.75 text-text-muted">Loading…</p>

    <template v-if="status && view">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3.5">
        <div class="min-w-50 flex-1 text-ui leading-5 text-text">Home</div>
        <div role="radiogroup" aria-label="Where your people live" class="flex shrink-0 items-center gap-1 rounded-[var(--radius-6)] bg-fill-5 p-0.5">
          <button type="button" role="radio" :aria-checked="status.home === 'pc'" :class="[SEG, status.home === 'pc' ? ON : OFF]" :disabled="busy !== null" @click="pick('pc')">
            <Monitor class="size-3.5" aria-hidden="true" /> This PC
          </button>
          <button type="button" role="radio" :aria-checked="status.home === 'connections'" :class="[SEG, status.home === 'connections' ? ON : OFF]" :title="view.canPick ? undefined : 'Not set up in this build yet'" :disabled="busy !== null || !view.canPick" @click="pick('connections')">
            <Cloud class="size-3.5" aria-hidden="true" /> Connections
          </button>
        </div>
      </div>

      <div v-if="status.note" class="border-b border-border py-3.5 text-ui leading-4.75 text-text-muted" data-testid="not-configured">{{ status.note }}</div>

      <div v-if="view.showAccount || view.showSignIn" class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3.5">
        <div class="flex min-w-50 flex-1 items-center gap-2.5">
          <template v-if="view.showAccount && status.account">
            <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-bg text-ui-sm font-medium text-accent" aria-hidden="true">{{ initialsOf(status.account.name) }}</span>
            <div class="min-w-0">
              <div class="truncate text-ui leading-5 text-text" data-testid="account-name">{{ status.account.name }}</div>
              <div v-if="status.account.email" class="truncate text-ui-sm leading-4 text-text-muted">{{ status.account.email }}</div>
            </div>
          </template>
          <span v-else class="text-ui leading-5 text-text-muted">Not signed in</span>
        </div>
        <button v-if="view.showSignIn" type="button" :class="status.home === 'connections' ? FILLED : BUTTON" :disabled="busy !== null" :aria-busy="busy === 'signin'" @click="run('signin', signIn)">
          <LogIn class="size-3.5" aria-hidden="true" /> {{ busy === 'signin' ? 'Waiting for your browser…' : 'Sign in with Connections' }}
        </button>
        <button v-else type="button" :class="BUTTON" :disabled="busy !== null" @click="run('signout', signOut)"><LogOut class="mr-1.5 size-3.5" aria-hidden="true" /> Sign out</button>
      </div>

      <div v-if="view.showSync" class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3.5">
        <div class="min-w-50 flex-1 text-ui leading-5 text-text-2" data-testid="sync-line">
          <span :title="when">{{ syncLine(status, now) }}</span>
        </div>
        <button type="button" :class="BUTTON" :disabled="busy !== null || status.syncing" :aria-busy="busy === 'sync' || status.syncing" @click="run('sync', syncNow)">
          <RefreshCw class="mr-1.5 size-3.5" :class="busy === 'sync' || status.syncing ? 'animate-spin' : ''" aria-hidden="true" /> Sync now
        </button>
      </div>
    </template>

    <p v-if="error" class="mt-3 text-ui leading-4.75 text-danger-text" role="alert" data-testid="people-where-error">{{ error }}</p>
  </div>
</template>

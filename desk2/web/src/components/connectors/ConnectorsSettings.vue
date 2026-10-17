<script setup lang="ts">
import { ChevronDown, ChevronUp, CircleX, FolderGit2, Globe, LoaderCircle, Palette, Plug, ScanSearch, Server } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, type Component } from 'vue'
import type { ConnectorAction, ConnectorId, ConnectorView } from '@shared/connectors'
import PaneSwitch from '@/components/panes/PaneSwitch.vue'
import { Tip } from '@/components/ui/tooltip'
import { serviceLine } from '@/components/servers/logic'
import { useDevServers } from '@/components/servers/store'
import { BUTTON } from '@/components/panes/settings-styles'
import { listConnectors, runConnectorAction } from './api'
import { canTurnOn, note, pollDelay, rowButtons, stateLabel, stateTone, typeLabel, versionLabel } from './settings-logic'

// Settings → Connectors (owner, 2026-10-16: "in a nice table ... like how connectors in Claude ... or basically all other
// services do this"): one row per outside app Desk hooks in (shared/connectors.ts), its name, type, status, its one action and
// its switch; what it gives a chat, why it is absent and its homepage open in place under it. Polled every 3 s while one
// installs or starts, else every 15 s, and only while this section is on screen and the window shown.
const views = shallowRef<ConnectorView[]>([])
const loaded = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let gone = false

// One timer at a time: every path that re-arms clears the old one first, and never while the window is hidden.
function arm() {
  if (timer) clearTimeout(timer)
  timer = null
  if (!gone && !document.hidden) timer = setTimeout(load, pollDelay(views.value))
}

async function load() {
  try {
    const next = await listConnectors()
    // An unchanged answer (the usual one, on every poll) must not swap the list in: every row would re-render for nothing.
    if (JSON.stringify(next) !== JSON.stringify(views.value)) views.value = next
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  loaded.value = true
  arm()
}

const acting = ref<string[]>([])
const actingKey = (v: ConnectorView, action: ConnectorAction) => `${v.id}:${action}`
const actingOn = (v: ConnectorView, action: ConnectorAction) => acting.value.includes(actingKey(v, action))

async function act(v: ConnectorView, action: ConnectorAction) {
  const key = actingKey(v, action)
  acting.value = [...acting.value, key]
  try {
    const next = await runConnectorAction(v.id, action)
    views.value = views.value.map((x) => (x.id === next.id ? next : x))
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    acting.value = acting.value.filter((k) => k !== key)
  }
  // An install or start is now under way: look again soon, not in 15 s.
  arm()
}

const opened = shallowRef<ReadonlySet<ConnectorId>>(new Set())
function toggle(id: ConnectorId) {
  const next = new Set(opened.value)
  if (!next.delete(id)) next.add(id)
  opened.value = next
}

// The dev-servers row also shows the service itself (GET /dw/status, through the shared client that polls only while
// this section is on screen): its state, and Restart / Stop in its details. It asks for nothing: the service is not
// started from here.
const dev = useDevServers()
const devLine = computed(() => serviceLine(dev.status.value))
const devBusy = ref(false)
const devError = ref<string | null>(null)
let releaseDev: (() => void) | null = null
async function devService(action: 'restart' | 'stop') {
  devBusy.value = true
  devError.value = null
  try {
    await dev.service(action)
  } catch (e) {
    devError.value = e instanceof Error ? e.message : String(e)
  } finally {
    devBusy.value = false
  }
}

const open = (v: ConnectorView) => v.url && window.open(v.url, '_blank', 'noopener')
const dot = { ok: 'var(--success)', busy: 'var(--warning, var(--text-muted))', bad: 'var(--danger)', idle: 'var(--text-muted)' }
const ICONS: Record<ConnectorId, Component> = { repoyeti: FolderGit2, redesign: Palette, devwebui: Server, connections: Plug, browser: Globe, teardown: ScanSearch }
const STOP = BUTTON.replace(' text-text ', ' text-danger-text ')
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_64px_120px_64px_36px_28px] items-center gap-x-3'
const switchTip = (v: ConnectorView) =>
  canTurnOn(v) ? (v.enabled ? `New chats get ${v.name}'s tools` : `New chats do not get ${v.name}'s tools`) : v.installable ? 'Install it first' : 'Not on this PC'

// A hidden window polls nothing; coming back looks at once rather than serving a stale view.
function onVisibility() {
  if (document.hidden) {
    if (timer) clearTimeout(timer)
    timer = null
  } else void load()
}

onMounted(() => {
  releaseDev = dev.use({ quiet: true })
  document.addEventListener('visibilitychange', onVisibility)
  void load()
})
onBeforeUnmount(() => {
  gone = true
  releaseDev?.()
  document.removeEventListener('visibilitychange', onVisibility)
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div role="group" aria-label="Connectors">
    <h3 class="text-ui font-semibold leading-5 text-text">Connectors</h3>
    <p class="mt-0.5 text-ui leading-4.75 text-text-muted">Apps whose tools every new chat gets while they run</p>
    <p v-if="error" class="mt-2 text-ui leading-4.75 text-danger-text" role="alert">{{ error }}</p>
    <p v-if="!loaded" class="mt-4 text-ui leading-4.75 text-text-muted">Loading…</p>
    <div v-else role="table" aria-label="Connectors" class="mt-3">
      <div role="row" :class="COLUMNS" class="h-7 border-b border-border text-ui-sm leading-4.5 text-text-muted">
        <span role="columnheader">Connector</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" class="sr-only">Action</span>
        <span role="columnheader">On</span>
        <span role="columnheader" class="sr-only">Details</span>
      </div>
      <div v-for="v in views" :key="v.id" role="rowgroup" class="border-b border-border last:border-b-0">
        <div role="row" :class="COLUMNS" class="min-h-10 cursor-default py-1.5" :data-connector="v.id" @click="toggle(v.id)">
          <div role="cell" class="flex min-w-0 items-center gap-2">
            <component :is="ICONS[v.id]" class="size-4 shrink-0 text-text-2" aria-hidden="true" />
            <span class="truncate text-ui leading-5 text-text">{{ v.name }}</span>
            <span v-if="versionLabel(v)" class="shrink-0 font-mono text-ui-sm text-text-muted">{{ versionLabel(v) }}</span>
          </div>
          <span role="cell" class="text-ui-sm leading-4.5 text-text-2">{{ typeLabel(v) }}</span>
          <div role="cell" class="flex min-w-0 items-center gap-1.5 text-ui-sm leading-4.5" :class="v.state === 'failed' ? 'text-danger-text' : 'text-text-2'">
            <LoaderCircle v-if="stateTone(v) === 'busy'" class="size-3.5 shrink-0 animate-spin text-text-muted" aria-hidden="true" />
            <CircleX v-else-if="v.state === 'failed'" class="size-3.5 shrink-0" aria-hidden="true" />
            <span v-else class="inline-block size-2 shrink-0 rounded-full" :style="{ background: dot[stateTone(v)] }" aria-hidden="true" />
            <Tip v-if="v.reason && (v.state === 'failed' || v.state === 'installing')" :label="v.reason">
              <span class="truncate">{{ stateLabel(v) }}</span>
            </Tip>
            <span v-else class="truncate">{{ stateLabel(v) }}</span>
          </div>
          <div role="cell" class="flex justify-end" @click.stop>
            <button v-if="rowButtons(v).install" type="button" :class="BUTTON" :disabled="actingOn(v, 'install')" :aria-busy="actingOn(v, 'install')" @click="act(v, 'install')">Install</button>
            <button v-else-if="rowButtons(v).start" type="button" :class="BUTTON" :disabled="actingOn(v, 'start')" :aria-busy="actingOn(v, 'start')" @click="act(v, 'start')">Start</button>
            <button v-else-if="rowButtons(v).open" type="button" :class="BUTTON" @click="open(v)">Open</button>
          </div>
          <div role="cell" class="flex" @click.stop>
            <Tip :label="switchTip(v)">
              <span class="inline-flex">
                <PaneSwitch :label="`Give chats ${v.name}'s tools`" :model-value="v.enabled && canTurnOn(v)" :disabled="!canTurnOn(v)" @update:model-value="(on: boolean) => act(v, on ? 'enable' : 'disable')" />
              </span>
            </Tip>
          </div>
          <div role="cell" class="flex justify-end">
            <button
              type="button"
              class="flex size-7 cursor-default items-center justify-center rounded-[var(--radius-6)] text-text-muted hover:bg-fill-hover hover:text-text"
              :aria-expanded="opened.has(v.id)"
              :aria-label="`Details of ${v.name}`"
              @click.stop="toggle(v.id)"
            >
              <component :is="opened.has(v.id) ? ChevronUp : ChevronDown" class="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div v-if="opened.has(v.id)" role="row" class="pb-2.5 pl-6 pr-9">
          <div role="cell" class="space-y-1 text-ui-sm leading-4.5 text-text-2">
            <p>{{ v.blurb }}</p>
            <p v-if="note(v)" class="wrap-break-word text-text-muted">{{ note(v) }}</p>
            <p v-if="v.reason && v.state === 'failed'" class="wrap-break-word text-danger-text">{{ v.reason }}</p>
            <p v-if="v.reason && v.state === 'installing'" class="wrap-break-word text-text-muted">{{ v.reason }}</p>
            <div v-if="v.id === 'devwebui'" class="flex flex-wrap items-center gap-2 pt-0.5" role="status" aria-label="Dev servers service">
              <span class="inline-block size-2 shrink-0 rounded-full" :style="{ background: dot[devLine.tone] }" aria-hidden="true" />
              <span>{{ devLine.text }}</span>
              <button type="button" :class="BUTTON" class="ml-auto" :disabled="devBusy" @click="devService('restart')">Restart</button>
              <Tip label="Stops the dev servers AgentHydra started">
                <button type="button" :class="STOP" :disabled="devBusy || dev.status.value?.state === 'stopped'" @click="devService('stop')">Stop</button>
              </Tip>
            </div>
            <p v-if="v.id === 'devwebui' && devError" class="wrap-break-word text-danger-text">{{ devError }}</p>
            <a :href="v.homepage" target="_blank" rel="noopener noreferrer" class="inline-block text-text-2 underline hover:text-text">Homepage</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Settings → Command packs (docs/COMMAND-PACKS.md). Purpose: which team packs reach this PC's accounts, are they
// current, and did anything keep a copy from landing. A pack is one line (its name, branch, what it gives, a red
// trash can); its commands, skills and why it could not be pulled open in place under it. The list is AgentHydra's
// (/ah/api/command-packs); a save starts a sync there, and this section polls every 2 s while one runs, else every
// 30 s, only while it is on screen and the window shown.
import { ChevronDown, ChevronUp, CircleX, FolderGit2, GitBranch, RefreshCw, Trash2 } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { usePaneApi } from './api'
import { accountNotes, type CommandPack, type CommandPacksView, type PackStatus, packCounts, packKey, packName, statusesByKey, summaryLine } from './command-packs'
import { BUTTON, FIELD } from './settings-styles'

const api = usePaneApi()
const view = shallowRef<CommandPacksView | null>(null)
const error = ref<string | null>(null)
const saving = ref(false)
const url = ref('')
const branch = ref('')
const open = shallowRef<ReadonlySet<string>>(new Set())
const removed = shallowRef<{ name: string; packs: CommandPack[] } | null>(null)
const now = ref(Date.now())
let timer: ReturnType<typeof setTimeout> | null = null
let undoTimer: ReturnType<typeof setTimeout> | null = null
let gone = false

const keyOf = (p: CommandPack) => packKey(p.url, p.branch)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function arm() {
  if (timer) clearTimeout(timer)
  timer = null
  if (!gone && !document.hidden) timer = setTimeout(load, view.value?.busy ? 2000 : 30_000)
}

async function load() {
  try {
    view.value = await api.agentHydra<CommandPacksView>('/command-packs')
    error.value = null
  } catch (e) {
    error.value = message(e)
  }
  now.value = Date.now()
  arm()
}

async function save(packs: CommandPack[]): Promise<boolean> {
  saving.value = true
  try {
    view.value = await api.agentHydra<CommandPacksView>('/command-packs', { method: 'PUT', body: JSON.stringify({ packs }) })
    error.value = null
    return true
  } catch (e) {
    error.value = message(e)
    return false
  } finally {
    saving.value = false
    arm()
  }
}

async function add() {
  const next = { url: url.value.trim(), branch: branch.value.trim() || null }
  if (!next.url || !view.value) return
  if (await save([...view.value.packs, next])) {
    url.value = ''
    branch.value = ''
  }
}

async function remove(pack: CommandPack) {
  if (!view.value) return
  const before = view.value.packs
  if (await save(before.filter((p) => keyOf(p) !== keyOf(pack)))) {
    removed.value = { name: packName(pack.url), packs: before }
    if (undoTimer) clearTimeout(undoTimer)
    undoTimer = setTimeout(() => (removed.value = null), 10_000)
  }
}

async function undo() {
  const r = removed.value
  removed.value = null
  if (r) await save(r.packs)
}

async function syncNow() {
  try {
    view.value = await api.agentHydra<CommandPacksView>('/command-packs/sync', { method: 'POST' })
    error.value = null
  } catch (e) {
    error.value = message(e)
  }
  arm()
}

function toggle(key: string) {
  const next = new Set(open.value)
  if (!next.delete(key)) next.add(key)
  open.value = next
}

const rows = computed(() => {
  const statuses = view.value ? statusesByKey(view.value) : new Map<string, PackStatus>()
  return (view.value?.packs ?? []).map((p) => {
    const key = keyOf(p)
    const status = statuses.get(key) ?? null
    return { pack: p, key, name: packName(p.url), status, counts: packCounts(status), open: open.value.has(key) }
  })
})
const summary = computed(() => (view.value ? summaryLine(view.value, now.value) : ''))
const notes = computed(() => (view.value ? accountNotes(view.value) : []))
const lastRun = computed(() => (view.value?.run ? new Date(view.value.run.at).toLocaleString() : ''))

function onVisibility() {
  if (document.hidden) {
    if (timer) clearTimeout(timer)
    timer = null
  } else void load()
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  void load()
})
onBeforeUnmount(() => {
  gone = true
  document.removeEventListener('visibilitychange', onVisibility)
  if (timer) clearTimeout(timer)
  if (undoTimer) clearTimeout(undoTimer)
})
</script>

<template>
  <div role="group" aria-label="Command packs">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h3 class="text-ui font-semibold leading-5 text-text">Command packs</h3>
        <Tip :label="lastRun ? `Last sync ${lastRun}` : 'Git repos of slash commands and skills, copied into every account'">
          <p class="mt-0.5 text-ui leading-4.75 text-text-muted" aria-label="Command packs status">{{ view ? summary : 'Loading…' }}</p>
        </Tip>
      </div>
      <button type="button" :class="BUTTON" class="gap-1.5" :disabled="!view || view.busy" :aria-busy="view?.busy" @click="syncNow">
        <RefreshCw class="size-3.5" :class="view?.busy ? 'animate-spin' : ''" aria-hidden="true" />
        {{ view?.busy ? 'Syncing…' : 'Sync now' }}
      </button>
    </div>
    <p v-if="error" class="mt-2 text-ui leading-4.75 text-danger-text" role="alert">{{ error }}</p>
    <p v-if="removed" class="mt-2 flex items-center gap-2 text-ui leading-4.75 text-text-2" role="status">
      Removed {{ removed.name }}
      <button type="button" class="text-ui text-text underline" @click="undo">Undo</button>
    </p>

    <div class="mt-3" role="list" aria-label="Packs">
      <div v-for="r in rows" :key="r.key" role="listitem" class="border-b border-border py-2 last:border-b-0">
        <div class="flex min-h-7 items-center gap-2">
          <component :is="r.status?.error ? CircleX : FolderGit2" class="size-4 shrink-0" :class="r.status?.error ? 'text-danger-text' : 'text-text-muted'" aria-hidden="true" />
          <Tip :label="r.pack.url">
            <span class="min-w-0 truncate text-ui leading-5 text-text">{{ r.name }}</span>
          </Tip>
          <span v-if="r.pack.branch" class="flex shrink-0 items-center gap-1 text-ui-sm text-text-muted">
            <GitBranch class="size-3" aria-hidden="true" />{{ r.pack.branch }}
          </span>
          <span class="ml-auto shrink-0 whitespace-nowrap text-ui-sm leading-4.5" :class="r.status?.error && !r.status.head ? 'text-danger-text' : 'text-text-2'">
            {{ r.status?.error && !r.status.head ? 'Cannot pull' : r.counts }}
          </span>
          <Tip :label="r.open ? 'Hide its commands and skills' : 'Show its commands and skills'">
            <button type="button" class="flex size-7 shrink-0 cursor-default items-center justify-center rounded-[var(--radius-6)] text-text-muted hover:bg-fill-hover hover:text-text" :aria-expanded="r.open" :aria-label="`Details of ${r.name}`" @click="toggle(r.key)">
              <component :is="r.open ? ChevronUp : ChevronDown" class="size-4" aria-hidden="true" />
            </button>
          </Tip>
          <Tip label="Remove pack">
            <button type="button" class="flex size-7 shrink-0 cursor-default items-center justify-center rounded-[var(--radius-6)] text-danger-text hover:bg-fill-hover" :aria-label="`Remove ${r.name}`" :disabled="saving" @click="remove(r.pack)">
              <Trash2 class="size-4" aria-hidden="true" />
            </button>
          </Tip>
        </div>
        <div v-if="r.open" class="ml-6 mt-1 space-y-1 text-ui-sm leading-4.5 text-text-2">
          <p v-if="r.status?.error" class="wrap-break-word text-danger-text">{{ r.status.head ? 'Last pull failed, using the copy already here: ' : '' }}{{ r.status.error }}</p>
          <p v-if="r.status?.commands.length"><span class="text-text-muted">Commands</span> {{ r.status.commands.map((c) => '/' + c.replace(/\.md$/i, '')).join(', ') }}</p>
          <p v-if="r.status?.skills.length"><span class="text-text-muted">Skills</span> {{ r.status.skills.join(', ') }}</p>
          <p v-if="r.status?.shadowed.length"><span class="text-text-muted">Given by an earlier pack</span> {{ r.status.shadowed.join(', ') }}</p>
          <p v-if="r.status?.head" class="text-text-muted">Commit {{ r.status.head.slice(0, 7) }}</p>
        </div>
      </div>
    </div>

    <form class="mt-3 flex flex-wrap items-center gap-2" aria-label="Add a pack" @submit.prevent="add">
      <input v-model="url" :class="FIELD" class="min-w-60 flex-1" placeholder="Git URL" aria-label="Pack Git URL" spellcheck="false" />
      <input v-model="branch" :class="FIELD" class="w-36" placeholder="Branch (optional)" aria-label="Pack branch" spellcheck="false" />
      <button type="submit" :class="BUTTON" :disabled="!url.trim() || saving || !view">Add pack</button>
    </form>

    <div v-if="notes.length" class="mt-6" role="group" aria-label="Accounts with notes">
      <h3 class="text-ui font-semibold leading-5 text-text">Kept as they are</h3>
      <div v-for="t in notes" :key="t.dir" class="border-b border-border py-2 text-ui-sm leading-4.5 last:border-b-0">
        <Tip :label="t.dir"><span class="text-ui leading-5 text-text">{{ t.label }}</span></Tip>
        <p v-if="t.error" class="text-danger-text">Not written: {{ t.error }}</p>
        <p v-if="t.edited.length" class="wrap-break-word text-text-2"><span class="text-text-muted">Edited here, not updated</span> {{ t.edited.join(', ') }}</p>
        <p v-if="t.keptOwn.length" class="wrap-break-word text-text-2"><span class="text-text-muted">Its own file, not replaced</span> {{ t.keptOwn.join(', ') }}</p>
      </div>
    </div>
  </div>
</template>

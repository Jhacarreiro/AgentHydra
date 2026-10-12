<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ArrowLeft, Copy, Folder } from '@lucide/vue'
import { useElementSize } from '@vueuse/core'
import type { Dashboard } from '@shared/dashboards'
import type { ProjectEntry } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { Tip } from '@/components/ui/tooltip'
import DashboardCard from './DashboardCard.vue'
import { getDashboard, writeDashboard } from './api'
import { cardSpan, EXAMPLE_PROMPT, gridColumns, isWebLink, removeBody, timeAgo, widgetSize, workspaceKey } from './logic'
import { closeDashboard, refreshDashboards } from './store'

// The project dashboard, a page in the sliding track (DeskFrame). It re-reads every 5 seconds while it is on screen, one
// loop, stopped when it closes; the scroll position stays, since the element is not remounted between reads.
const props = defineProps<{ cwd: string | null; active: boolean; padLeft: number }>()
const src = useShellSource()
const POLL_MS = 5000

const dash = shallowRef<Dashboard | null>(null)
const project = shallowRef<ProjectEntry | null>(null)
const problem = ref<string | null>(null)
const loaded = ref(false)
const now = ref(Date.now())
const content = ref<HTMLElement | null>(null)
const { width } = useElementSize(content)
const columns = computed(() => gridColumns(width.value || 960))
const gridStyle = computed(() => ({ gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))` }))
const folderName = computed(() => (props.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '')
const title = computed(() => dash.value?.name || project.value?.name || folderName.value)
const path = computed(() => props.cwd ?? '')
const updated = computed(() => timeAgo(dash.value?.updatedAt, now.value))
const cards = computed(() => (dash.value?.widgets ?? []).map((w) => ({ widget: w, span: cardSpan(widgetSize(w), columns.value) })))

let timer: ReturnType<typeof setInterval> | undefined
let seq = 0

async function load(): Promise<void> {
  const cwd = props.cwd
  if (!cwd) return
  const mine = ++seq
  try {
    const d = await getDashboard(cwd)
    if (mine !== seq) return
    dash.value = d
    problem.value = null
    void refreshDashboards()
  } catch (err) {
    if (mine !== seq) return
    problem.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (mine === seq) {
      loaded.value = true
      now.value = Date.now()
    }
  }
}

async function loadProject(cwd: string): Promise<void> {
  const res = await src.projects?.({ hidden: true }).catch(() => null)
  const key = workspaceKey(cwd)
  project.value = res?.projects.find((p) => workspaceKey(p.path) === key) ?? null
}

function start(): void {
  stop()
  void load()
  timer = setInterval(() => {
    now.value = Date.now()
    void load()
  }, POLL_MS)
}
function stop(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

watch(
  () => [props.active, props.cwd] as const,
  ([active, cwd], prev) => {
    if (cwd !== prev?.[1]) {
      dash.value = null
      loaded.value = false
      problem.value = null
      project.value = null
      if (cwd) void loadProject(cwd)
    }
    if (active && cwd) start()
    else if (!active) stop()
  },
  { immediate: true }
)
onBeforeUnmount(stop)

async function remove(id: string): Promise<void> {
  if (!props.cwd) return
  try {
    dash.value = await writeDashboard(removeBody(props.cwd, id))
    problem.value = null
  } catch (err) {
    problem.value = err instanceof Error ? err.message : String(err)
  }
}

function link(href: string): void {
  if (isWebLink(href)) {
    window.open(href.trim(), '_blank', 'noopener')
    return
  }
  src.revealFolder(href).catch((err: unknown) => {
    problem.value = err instanceof Error ? err.message : String(err)
  })
}

const copied = ref(false)
function copyPrompt(): void {
  void navigator.clipboard.writeText(EXAMPLE_PROMPT).then(() => {
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  })
}
</script>

<template>
  <section class="flex h-full min-w-0 flex-1 flex-col bg-(--bg-page)" data-testid="dashboard-page" :aria-label="`Dashboard for ${title}`">
    <header class="flex h-10.25 shrink-0 items-center gap-3 pe-4" :style="{ paddingInlineStart: `${padLeft}px` }">
      <Tip label="Back to the chat">
        <button type="button" aria-label="Back to the chat" class="flex size-7 shrink-0 items-center justify-center rounded-(--radius-8) text-text-2 hover:bg-fill-hover hover:text-text" @click="closeDashboard()">
          <ArrowLeft class="size-4" aria-hidden="true" />
        </button>
      </Tip>
      <img v-if="project?.icon" :src="project.icon" alt="" class="size-6 shrink-0 rounded-(--radius-6)" />
      <span v-else class="flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) bg-(--fill-secondary) text-text-muted">
        <Folder class="size-3.5" aria-hidden="true" />
      </span>
      <div class="flex min-w-0 flex-1 items-baseline gap-2">
        <h2 class="truncate text-[15px] leading-5 font-semibold text-text">{{ title }}</h2>
        <span class="min-w-0 truncate text-[11px] leading-4 text-text-muted" :title="path">{{ path }}</span>
        <span v-if="updated" class="shrink-0 text-[11px] leading-4 text-text-muted">updated {{ updated }}</span>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div ref="content" class="mx-auto flex w-full max-w-240 flex-col gap-4 px-6 pb-10 pt-4">
        <p v-if="problem" role="alert" class="text-[12px] leading-4 text-text-muted">
          Could not reach AgentHydra: <span class="text-danger">{{ problem }}</span>
        </p>

        <div v-if="cards.length" class="grid gap-3" :style="gridStyle">
          <DashboardCard v-for="c in cards" :key="c.widget.id" :widget="c.widget" :span="c.span" :now="now" @remove="remove" @link="link" />
        </div>

        <div v-else-if="loaded" class="mt-16 flex flex-col items-center gap-3 text-center">
          <h3 class="text-[15px] leading-5 font-semibold text-text">No dashboard yet</h3>
          <p class="max-w-md text-[13px] leading-5 text-text-muted">Ask any chat in this project to put something here. It writes with dashboard_write on the agenthydra MCP.</p>
          <div class="flex items-center gap-2 rounded-(--radius-8) bg-fill-5 py-1.5 ps-3 pe-1.5">
            <code class="text-[12px] leading-4 text-text-2">{{ EXAMPLE_PROMPT }}</code>
            <button type="button" class="flex h-6 items-center gap-1 rounded-(--radius-5) bg-(--fill-secondary) px-2 text-[12px] leading-4 text-text-2 hover:text-text" @click="copyPrompt">
              <Copy class="size-3" aria-hidden="true" />{{ copied ? 'Copied' : 'Copy' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

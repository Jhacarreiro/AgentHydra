// The Tools tab's managers, read from Desk's server: GET /api/babysitter, GET /api/diagnostics/orchestrator (the
// orchestrator's plan) and GET /api/instance-manager. One poll (WARM_MS) while the tab is on screen (`active`) and
// the pane is visible. Routines are not here: ToolsView polls them with getRoutines (routines-api.ts). The paths are
// relative, as routines-api.ts's are: they are Desk's own routes, never API_BASE's (/ah, the daemon's), where every
// read answered 404 until 2026-10-16. A 404 means this window runs without Desk, where these routes do not answer:
// `available` is false and nothing errors.
import type { BabysitterStatus } from '@desk/shared/babysitter'
import type { InstanceManagerStatus } from '@desk/shared/instance-manager'
import type { OrchestratorPlan } from '@desk/shared/orchestrator'
import { onBeforeUnmount, reactive, shallowRef, watch } from 'vue'
import { WARM_MS } from '@/lib/warm-data'

export function useTools(active: { readonly value: boolean }) {
  const babysitter = shallowRef<BabysitterStatus | null>(null)
  const orchestrator = shallowRef<OrchestratorPlan | null>(null)
  const instanceManager = shallowRef<InstanceManagerStatus | null>(null)
  // null until the first read; false when Desk's routes do not answer (the window runs without Desk).
  const available = shallowRef<boolean | null>(null)
  const error = shallowRef<string | null>(null)
  let timer: number | undefined

  // Null when the route is not there (404): this window runs without Desk.
  async function read<T>(path: string): Promise<T | null> {
    const res = await fetch(path, { headers: { accept: 'application/json' } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return (await res.json()) as T
  }

  async function refresh(): Promise<void> {
    try {
      const [b, o, i] = await Promise.all([
        read<BabysitterStatus>('/api/babysitter'),
        read<OrchestratorPlan>('/api/diagnostics/orchestrator'),
        read<InstanceManagerStatus>('/api/instance-manager'),
      ])
      available.value = b !== null && o !== null && i !== null
      babysitter.value = b
      orchestrator.value = o
      instanceManager.value = i
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  function stop() {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
  }
  watch(
    () => active.value,
    (on) => {
      stop()
      if (!on) return
      void refresh()
      timer = window.setInterval(() => {
        if (document.visibilityState !== 'hidden') void refresh()
      }, WARM_MS)
    },
    { immediate: true },
  )
  onBeforeUnmount(stop)

  return reactive({ babysitter, orchestrator, instanceManager, available, error, refresh })
}

export type Tools = ReturnType<typeof useTools>

// Desk's own settings (GET and PUT /api/settings, the same routes Desk's Settings reads and writes), read by the Tools tab's
// on/off switches: babysitter, orchestrator, instanceManager (components/tools/). The paths are relative, as useTools.ts's
// and routines-api.ts's are: they are Desk's routes, never API_BASE's (/ah, the daemon's). A 404 means this window runs
// without Desk: `available` is false and nothing errors, and the switches stay hidden.
//
// The settings are one shared ref, so every page shows the same value. A save changes nothing until the server answers:
// the PUT's echo replaces the value, and a refusal keeps the old one and sets `error`, so a switch never shows a setting
// Desk did not keep. (Owner, 2026-10-17: the Settings > Managers switches moved onto the Tools tab's pages.)
import type { OrchestratorModelStatus } from '@desk/shared/orchestrator'
import type { DeskSettings } from '@desk/shared/protocol'
import { reactive, shallowRef } from 'vue'

export type DeskSettingsPatch = Partial<DeskSettings>

const settings = shallowRef<DeskSettings | null>(null)
// null until the first read; false when Desk's routes do not answer (the window runs without Desk).
const available = shallowRef<boolean | null>(null)
const orchestratorModel = shallowRef<OrchestratorModelStatus | null>(null)
const error = shallowRef<string | null>(null)
const saving = shallowRef(false)

/** A reason from Desk's body (`{ error }`), else the status line. */
async function reasonOf(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null)
  const reason = (body as { error?: unknown } | null)?.error
  return typeof reason === 'string' ? reason : `${res.status} ${res.statusText}`
}

/** GET /api/orchestrator/model: the orchestratorModel setting, and the model id the SDK reported for it. Null without Desk. */
async function readOrchestratorModel(): Promise<OrchestratorModelStatus | null> {
  const res = await fetch('/api/orchestrator/model', { headers: { accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await reasonOf(res))
  return (await res.json()) as OrchestratorModelStatus
}

export function useDeskSettings() {
  /** GET /api/settings. A 404 is 'no Desk': nothing errors, the switches hide. */
  async function refresh(): Promise<void> {
    try {
      const res = await fetch('/api/settings', { headers: { accept: 'application/json' } })
      if (res.status === 404) {
        available.value = false
        settings.value = null
        return
      }
      if (!res.ok) throw new Error(await reasonOf(res))
      settings.value = (await res.json()) as DeskSettings
      available.value = true
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** PUT /api/settings with a patch. Resolves with the reason when Desk refused it (the old value stays), else null. */
  async function save(patch: DeskSettingsPatch): Promise<string | null> {
    saving.value = true
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-Desk-Caller': 'window' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(await reasonOf(res))
      settings.value = (await res.json()) as DeskSettings
      error.value = null
      return null
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      error.value = reason
      return reason
    } finally {
      saving.value = false
    }
  }

  /** GET /api/orchestrator/model for the Orchestrator page's model row. */
  async function refreshOrchestratorModel(): Promise<void> {
    try {
      orchestratorModel.value = await readOrchestratorModel()
    } catch {
      orchestratorModel.value = null
    }
  }

  return reactive({ settings, available, orchestratorModel, error, saving, refresh, save, refreshOrchestratorModel })
}

export type DeskSettingsStore = ReturnType<typeof useDeskSettings>

<script setup lang="ts">
// One standing agent's page: its state, headline, totals and settings (read-only, as the agent reports them), its last
// run and next due, Run now, and the work it started: CliMayte workers and HSwarm jobs, drawn by HSwarmJobs (filtered by
// the agent's name, lib/managers.ts). A click on that work opens it where those rows already open.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import type { Managers } from '@/composables/useManagers'
import HSwarmJobs from '@/components/hswarm/HSwarmJobs.vue'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'
import type { HswarmState } from '@/lib/hswarm-api'
import { timeAgo } from '@/lib/format'
import { MANAGER_DOT_CLASS, agentDot, canRunAgent, outcomeTone } from '@/lib/managers'

const props = defineProps<{ agent: string; managers: Managers; state: HswarmState | null }>()
const emit = defineEmits<{ 'open-task': [id: string, wave: boolean] }>()
const { t } = useI18n()

const g = computed(() => props.managers.archaingel?.agents.find((x) => x.id === props.agent) ?? null)
const last = computed(() => g.value?.runs[0] ?? null)
const totals = computed(() => Object.entries(g.value?.totals ?? {}))
const settings = computed(() => Object.entries(g.value?.settings ?? {}))
const canRun = computed(() => !!g.value && props.managers.available !== false && canRunAgent(g.value.state, props.managers.busy === props.agent))
const dueText = computed(() => {
  const x = g.value
  if (!x || x.state === 'off' || x.state === 'broken' || x.state === 'running') return '—'
  return x.nextTickAt == null ? t('hswarm.v.managers.archaingel.now') : new Date(x.nextTickAt).toLocaleString()
})

// The Run now button's answer: a started tick is a toast; a refusal (busy, broken, unknown) says why.
const running = ref(false)
async function runNow() {
  if (!g.value || running.value) return
  running.value = true
  try {
    await props.managers.runAgent(props.agent)
    toast.success(t('hswarm.v.managers.agent.runStarted', { name: g.value.name }))
  } catch (err) {
    toast.error(t('hswarm.v.managers.agent.runError', { error: err instanceof Error ? err.message : String(err) }))
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <Card size="sm">
      <CardHeader>
        <div class="flex flex-wrap items-center gap-2">
          <CardTitle size="lg">{{ g?.name ?? agent }}</CardTitle>
          <span v-if="g" class="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs">
            <span class="size-2 rounded-full" :class="MANAGER_DOT_CLASS[agentDot(g.state)]" />
            {{ t(`hswarm.v.managers.state.${g.state}`) }}
          </span>
          <Button v-if="EMBEDDED" size="sm" variant="outline" class="ms-auto" @click="openSettingsInDesk('managers')">
            {{ t('hswarm.v.managers.settings') }}
          </Button>
          <Button size="sm" :disabled="!canRun || running" @click="runNow">
            {{ running || managers.busy === agent ? t('hswarm.v.managers.agent.running') : t('hswarm.v.managers.agent.runNow') }}
          </Button>
        </div>
        <CardDescription v-if="g?.headline">{{ g.headline }}</CardDescription>
      </CardHeader>
      <CardContent stack="sm">
        <p v-if="!g" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.agent.notRegistered') }}</p>
        <p v-if="g && g.reason" class="text-xs text-muted-foreground">{{ g.reason }}</p>

        <template v-if="g">
          <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.agent.totals') }}</h3>
          <div v-if="totals.length" class="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div v-for="[k, v] in totals" :key="k" class="min-w-0 rounded-lg border bg-card px-3 py-2">
              <div class="truncate text-xs text-muted-foreground">{{ k }}</div>
              <div class="text-2xl font-semibold leading-8">{{ v }}</div>
            </div>
          </div>
          <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.nothingYet') }}</p>

          <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.agent.lastRun') }}</h3>
          <p v-if="last" class="text-sm">
            <span :class="outcomeTone(last.outcome)">{{ t(`hswarm.v.managers.outcome.${last.outcome}`) }}</span>
            · {{ timeAgo(last.endedAt) }}
          </p>
          <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.agent.noRun') }}</p>
          <p v-if="last?.lastLine" class="break-all rounded-md bg-muted/40 px-2 py-1 font-mono text-xs">{{ last.lastLine }}</p>
          <p class="text-xs text-muted-foreground">{{ t('hswarm.v.managers.agent.nextDue') }}: {{ dueText }}</p>

          <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.agent.settings') }}</h3>
          <Table v-if="settings.length">
            <TableBody>
              <TableRow v-for="[k, v] in settings" :key="k">
                <TableCell class="text-xs text-muted-foreground">{{ k }}</TableCell>
                <TableCell class="break-all text-xs">{{ String(v) }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.agent.noSettings') }}</p>
        </template>
      </CardContent>
    </Card>

    <Card size="sm">
      <CardHeader>
        <CardTitle size="lg">{{ t('hswarm.v.managers.agent.work') }}</CardTitle>
        <CardDescription>{{ t('hswarm.v.managers.agent.workNote', { id: agent }) }}</CardDescription>
      </CardHeader>
      <CardContent>
        <HSwarmJobs v-if="state" :state="state" :agent="agent" @open-task="(id, wave) => emit('open-task', id, wave)" />
        <p v-else class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.agent.noHswarm') }}</p>
      </CardContent>
    </Card>
  </div>
</template>

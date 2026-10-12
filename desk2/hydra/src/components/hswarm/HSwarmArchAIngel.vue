<script setup lang="ts">
// ArchAIngel's page (read-only): on or off, and its standing agents in a table. A click opens one agent's page.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Managers } from '@/composables/useManagers'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'
import { timeAgo } from '@/lib/format'
import { MANAGER_DOT_CLASS, agentDot, outcomeTone } from '@/lib/managers'

const props = defineProps<{ managers: Managers }>()
const emit = defineEmits<{ open: [path: string[]] }>()
const { t } = useI18n()

const a = computed(() => props.managers.archaingel)
const nextDue = (ms: number | null) => (ms == null ? t('hswarm.v.managers.archaingel.now') : new Date(ms).toLocaleString())
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <div class="flex flex-wrap items-center gap-2">
        <CardTitle size="lg">{{ t('hswarm.v.managers.archaingel.title') }}</CardTitle>
        <span v-if="a" class="rounded-md border px-1.5 py-0.5 text-xs" :class="a.enabled ? 'text-success' : 'text-muted-foreground'">
          {{ a.enabled ? t('hswarm.v.managers.on') : t('hswarm.v.managers.off') }}
        </span>
        <Button v-if="EMBEDDED" size="sm" variant="outline" class="ms-auto" @click="openSettingsInDesk('managers')">
          {{ t('hswarm.v.managers.settings') }}
        </Button>
      </div>
      <CardDescription>{{ t('hswarm.v.managers.archaingel.caption') }}</CardDescription>
    </CardHeader>
    <CardContent stack="sm">
      <p v-if="managers.error" class="text-xs text-destructive">{{ t('hswarm.v.managers.readError', { error: managers.error }) }}</p>
      <p v-if="a?.error" class="text-xs text-destructive">{{ a.error }}</p>
      <p v-if="!a" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.nothingYet') }}</p>

      <template v-if="a">
        <p class="text-xs text-muted-foreground">
          {{ t('hswarm.v.managers.lastLook') }}: {{ timeAgo(a.checkedAt) }} · {{ t('hswarm.v.managers.nextLook') }}: {{ a.nextCheckAt ? new Date(a.nextCheckAt).toLocaleTimeString() : '—' }}
        </p>
        <h3 class="text-sm font-medium">{{ t('hswarm.v.managers.archaingel.agents') }}</h3>
        <p v-if="!a.agents.length" class="text-sm text-muted-foreground">{{ t('hswarm.v.managers.archaingel.noAgents') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('hswarm.v.managers.archaingel.name') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.archaingel.state') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.archaingel.lastRun') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.archaingel.nextDue') }}</TableHead>
              <TableHead>{{ t('hswarm.v.managers.archaingel.headline') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="g in a.agents" :key="g.id">
              <TableCell>
                <button type="button" class="font-medium hover:underline" @click="emit('open', ['managers', 'archaingel', g.id])">
                  {{ g.name }}
                </button>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs">
                <span class="inline-flex items-center gap-1.5">
                  <span class="size-2 rounded-full" :class="MANAGER_DOT_CLASS[agentDot(g.state)]" />
                  {{ t(`hswarm.v.managers.state.${g.state}`) }}
                </span>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs">
                <template v-if="g.runs[0]">
                  <span :class="outcomeTone(g.runs[0].outcome)">{{ t(`hswarm.v.managers.outcome.${g.runs[0].outcome}`) }}</span>
                  · {{ timeAgo(g.runs[0].endedAt) }}
                </template>
                <template v-else>{{ t('hswarm.v.managers.agent.noRun') }}</template>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs">{{ g.state === 'off' || g.state === 'broken' ? '—' : nextDue(g.nextTickAt) }}</TableCell>
              <TableCell class="max-w-[18rem] truncate text-xs" :title="g.reason">{{ g.headline ?? g.reason }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </template>
    </CardContent>
  </Card>
</template>

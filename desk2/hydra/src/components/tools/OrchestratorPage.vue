<script setup lang="ts">
// The Orchestrator's page (read-only): what its GET route answers (/api/diagnostics/orchestrator): its mode, its last
// look, the chats it looked at, and what it did on its own.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Tools } from '@/composables/useTools'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'
import { timeAgo } from '@/lib/format'

const props = defineProps<{ tools: Tools }>()
const { t } = useI18n()

const p = computed(() => props.tools.orchestrator)
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <div class="flex flex-wrap items-center gap-2">
        <CardTitle size="lg" data-page-title tabindex="-1">{{ t('tools.managers.orchestrator.title') }}</CardTitle>
        <span v-if="p" class="rounded-md border px-1.5 py-0.5 text-xs" :class="p.mode === 'armed' ? 'text-success' : 'text-muted-foreground'">
          {{ p.mode === 'armed' ? t('tools.managers.orchestrator.armed') : t('tools.managers.orchestrator.shadow') }}
        </span>
        <Button v-if="EMBEDDED" size="sm" variant="outline" class="ms-auto" @click="openSettingsInDesk('managers')">
          {{ t('tools.managers.settings') }}
        </Button>
      </div>
      <CardDescription>{{ t('tools.managers.orchestrator.caption') }}</CardDescription>
    </CardHeader>
    <CardContent stack="sm">
      <p v-if="tools.error" class="text-xs text-destructive">{{ t('tools.managers.readError', { error: tools.error }) }}</p>
      <p v-if="!p" class="text-sm text-muted-foreground">{{ t('tools.managers.nothingYet') }}</p>

      <template v-if="p">
        <div class="grid grid-cols-2 gap-2">
          <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">{{ t('tools.managers.lastLook') }}</div>
            <div class="text-lg font-semibold leading-7">{{ timeAgo(p.at) }}</div>
            <p class="truncate text-xs text-muted-foreground">{{ t('tools.managers.orchestrator.days', { n: p.days }) }}</p>
          </div>
          <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">{{ t('tools.managers.orchestrator.rows') }}</div>
            <div class="text-2xl font-semibold leading-8">{{ p.rows.length }}</div>
            <p class="truncate text-xs text-muted-foreground">
              <template v-for="(n, move) in p.counts" :key="move">{{ move }} {{ n }} · </template>
            </p>
          </div>
        </div>

        <h3 class="text-sm font-medium">{{ t('tools.managers.orchestrator.acts') }}</h3>
        <p v-if="!p.acts.length" class="text-sm text-muted-foreground">{{ t('tools.managers.orchestrator.noActs') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('tools.managers.babysitter.whenHead') }}</TableHead>
              <TableHead>{{ t('tools.managers.babysitter.chatHead') }}</TableHead>
              <TableHead>{{ t('tools.managers.babysitter.didHead') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="a in p.acts" :key="`${a.at}-${a.id}`">
              <TableCell size="xs" class="whitespace-nowrap">{{ timeAgo(a.at) }}</TableCell>
              <TableCell class="max-w-[16rem]" truncate>{{ a.title }}</TableCell>
              <TableCell size="xs">
                {{ t(`tools.managers.orchestrator.did.${a.did}`, a.did) }}
                <span class="text-muted-foreground">· {{ a.error ?? a.detail ?? '' }}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </template>
    </CardContent>
  </Card>
</template>

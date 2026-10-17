<script setup lang="ts">
// The Instance manager's page (Tools > Managers): the apps it watches, and each recovery it made, newest first. Read-only;
// Desk's Settings holds the switch and the rules.
import type { InstanceManagerStatus } from '@desk/shared/instance-manager'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { EMBEDDED, openSettingsInDesk } from '@/lib/desk-embed'
import { MANAGER_DOT_CLASS, MANAGER_TEXT_CLASS, instanceManagerDot } from '@/lib/managers'
import { exactTime, relativeTime } from '@/lib/routine-words'

const props = defineProps<{ status: InstanceManagerStatus | null; now: number }>()

const { t } = useI18n()

const dot = computed(() => instanceManagerDot(props.status))

const word = computed(() => {
  if (!props.status) return t('tools.instanceManager.notRead')
  if (dot.value === 'bad') return t('tools.instanceManager.problem')
  if (dot.value === 'warn') return t('tools.instanceManager.attention')
  return props.status.enabled ? t('tools.instanceManager.on') : t('tools.instanceManager.off')
})

const recoveries = computed(() => [...(props.status?.recoveries ?? [])].sort((a, b) => b.at - a.at))

const lastLook = computed(() => {
  const at = props.status?.checkedAt ?? null
  return at === null ? t('tools.instanceManager.noLook') : `${t('tools.instanceManager.lastLook')} ${relativeTime(at, props.now)}`
})

const nextLook = computed(() => {
  const at = props.status?.nextCheckAt ?? null
  // relativeTime words a past instant as 'ago' and a look under a minute away as 'just now', so both read as due.
  if (at === null) return ''
  if (at - props.now < 60_000) return t('tools.instanceManager.dueNow')
  return `${t('tools.instanceManager.nextLook')} ${relativeTime(at, props.now)}`
})
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-4 p-4">
    <header class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h1 tabindex="-1" class="text-ui font-medium focus-visible:outline-2 focus-visible:outline-primary">{{ t('tools.instanceManager.title') }}</h1>
        <span class="flex items-center gap-1.5 text-2xs" :class="MANAGER_TEXT_CLASS[dot ?? 'off']">
          <span aria-hidden="true" class="size-2 rounded-full" :class="MANAGER_DOT_CLASS[dot ?? 'off']"></span>
          {{ word }}
        </span>
        <Button v-if="EMBEDDED" size="sm" variant="outline" class="ms-auto" @click="openSettingsInDesk('managers')">
          {{ t('tools.instanceManager.settings') }}
        </Button>
      </div>
      <p class="text-ui text-muted-foreground">{{ t('tools.instanceManager.caption') }}</p>
      <p class="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
        <span :title="exactTime(status?.checkedAt ?? null)">{{ lastLook }}</span>
        <span v-if="nextLook" :title="exactTime(status?.nextCheckAt ?? null)">{{ nextLook }}</span>
      </p>
      <p v-if="status?.error" class="text-ui text-destructive">{{ t('tools.instanceManager.readError', { reason: status.error }) }}</p>
    </header>

    <section aria-labelledby="instance-apps" class="flex flex-col gap-2">
      <h2 id="instance-apps" class="text-ui font-medium">{{ t('tools.instanceManager.apps.title') }}</h2>
      <div class="overflow-x-auto rounded-lg border bg-card">
        <table class="w-full text-ui">
          <caption class="px-3 py-2 text-start text-2xs text-muted-foreground">{{ t('tools.instanceManager.apps.caption') }}</caption>
          <thead class="bg-muted text-2xs text-muted-foreground">
            <tr>
              <th scope="col" class="px-3 py-1.5 text-start font-medium">{{ t('tools.instanceManager.apps.number') }}</th>
              <th scope="col" class="px-3 py-1.5 text-start font-medium">{{ t('tools.instanceManager.apps.name') }}</th>
              <th scope="col" class="px-3 py-1.5 text-start font-medium">{{ t('tools.instanceManager.apps.kind') }}</th>
              <th scope="col" class="px-3 py-1.5 text-start font-medium">{{ t('tools.instanceManager.apps.plan') }}</th>
              <th scope="col" class="px-3 py-1.5 text-start font-medium">{{ t('tools.instanceManager.apps.up') }}</th>
              <th scope="col" class="px-3 py-1.5 text-end font-medium">{{ t('tools.instanceManager.apps.working') }}</th>
              <th scope="col" class="px-3 py-1.5 text-start font-medium">{{ t('tools.instanceManager.apps.dead') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="app in status?.instances ?? []" :key="app.ref" class="border-t">
              <td class="px-3 py-1.5 tabular-nums">{{ app.num }}</td>
              <td class="px-3 py-1.5">{{ app.name }}</td>
              <td class="px-3 py-1.5">{{ t(`tools.instanceManager.kind.${app.kind}`) }}</td>
              <td class="px-3 py-1.5">{{ app.plan ?? '-' }}</td>
              <td class="px-3 py-1.5">{{ app.running && app.signedIn && !app.dead ? t('tools.instanceManager.yes') : t('tools.instanceManager.no') }}</td>
              <td class="px-3 py-1.5 text-end tabular-nums">{{ app.working }}</td>
              <td class="px-3 py-1.5 text-destructive">{{ app.dead ?? '' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!status?.instances.length" class="px-3 py-2 text-ui text-muted-foreground">{{ t('tools.instanceManager.apps.none') }}</p>
      </div>
    </section>

    <section aria-labelledby="instance-recoveries" class="flex flex-col gap-2">
      <h2 id="instance-recoveries" class="text-ui font-medium">{{ t('tools.instanceManager.recoveries.title') }}</h2>
      <p v-if="!recoveries.length" class="text-ui text-muted-foreground">{{ t('tools.instanceManager.recoveries.none') }}</p>
      <ul v-else role="list" class="flex flex-col gap-2">
        <li v-for="rec in recoveries" :key="rec.id" class="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
          <p class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-ui font-medium" :class="rec.state === 'failed' ? 'text-destructive' : ''">{{ t(`tools.instanceManager.recoveryState.${rec.state}`) }}</span>
            <span class="text-2xs text-muted-foreground">{{ t(`tools.instanceManager.cause.${rec.cause}`) }}</span>
            <span class="text-2xs text-muted-foreground" :title="exactTime(rec.at)">{{ t('tools.instanceManager.recoveries.seenDown', { when: relativeTime(rec.at, now) }) }}</span>
          </p>
          <p class="text-ui">
            {{
              t('tools.instanceManager.recoveries.fromTo', {
                from: rec.from.name,
                to: rec.to?.name ?? t('tools.instanceManager.recoveries.noTo'),
              })
            }}
          </p>
          <p v-if="rec.detail" class="text-2xs text-muted-foreground">{{ rec.detail }}</p>
          <ul v-if="rec.chats.length" role="list" class="flex flex-col gap-0.5 text-2xs">
            <li v-for="chat in rec.chats" :key="chat.id" class="flex flex-wrap gap-x-2">
              <span class="min-w-0 truncate">{{ chat.title }}</span>
              <span :class="chat.state === 'stuck' || chat.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
                {{ t(`tools.instanceManager.chatState.${chat.state}`) }}
              </span>
            </li>
          </ul>
        </li>
      </ul>
    </section>
  </div>
</template>

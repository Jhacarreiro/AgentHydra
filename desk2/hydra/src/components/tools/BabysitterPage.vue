<script setup lang="ts">
// The Babysitter's page: what GET /api/babysitter answers, the chats a usage limit stopped and what it did. Its on/off
// switch is Desk's `babysitter` setting (useDeskSettings.ts).
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useDeskSettings } from '@/composables/useDeskSettings'
import type { Tools } from '@/composables/useTools'
import { timeAgo } from '@/lib/format'
import { EMBEDDED } from '@/lib/desk-embed'
import { MANAGER_DOT_CLASS, MANAGER_TEXT_CLASS, babysitterActDot, babysitterChatDot, babysitterDot } from '@/lib/managers'

const props = defineProps<{ tools: Tools }>()
const { t } = useI18n()

const s = computed(() => props.tools.babysitter)

// Desk's setting: the switch shows only inside Desk (EMBEDDED) where Desk's settings route answers.
const desk = useDeskSettings()
const saveError = ref<string | null>(null)
const showSwitch = computed(() => EMBEDDED && desk.available === true)
onMounted(() => void desk.refresh())
async function setOn(on: boolean) {
  saveError.value = await desk.save({ babysitter: on })
  void props.tools.refresh()
}
// The stopped count takes the Babysitter's own colour while any chat is stopped (amber waiting, red needs a person).
const stoppedClass = computed(() => {
  const dot = babysitterDot(s.value)
  return s.value?.stopped.length && dot ? MANAGER_TEXT_CLASS[dot] : ''
})
const sourceName = (src: string) => t(`tools.managers.babysitter.source.${src}`, src)
const resetText = (ms: number | null) => (ms == null ? t('tools.managers.babysitter.noReset') : t('tools.managers.babysitter.resets', { when: new Date(ms).toLocaleString() }))
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <div class="flex flex-wrap items-center gap-2">
        <CardTitle size="lg" data-page-title tabindex="-1">{{ t('tools.managers.babysitter.title') }}</CardTitle>
        <span v-if="s" class="rounded-md border px-1.5 py-0.5 text-xs" :class="s.enabled ? 'text-success' : 'text-muted-foreground'">
          {{ s.enabled ? t('tools.managers.on') : t('tools.managers.off') }}
        </span>
        <Switch
          v-if="showSwitch"
          size="sm"
          class="ms-auto"
          :model-value="desk.settings?.babysitter ?? false"
          :disabled="desk.saving"
          :aria-label="t('tools.managers.switch.babysitter')"
          :title="t('tools.managers.switch.babysitter')"
          @update:model-value="setOn"
        />
      </div>
      <CardDescription>{{ t('tools.managers.babysitter.caption') }}</CardDescription>
    </CardHeader>
    <CardContent stack="sm">
      <p v-if="tools.error" class="text-xs text-destructive">{{ t('tools.managers.readError', { error: tools.error }) }}</p>
      <p v-if="saveError" class="text-xs text-destructive">{{ t('tools.managers.switch.saveError', { reason: saveError }) }}</p>
      <p v-if="s?.error" class="text-xs text-destructive">{{ s.error }}</p>
      <p v-if="!s" class="text-sm text-muted-foreground">{{ t('tools.managers.nothingYet') }}</p>

      <template v-if="s">
        <div class="grid grid-cols-2 gap-2">
          <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">{{ t('tools.managers.babysitter.stopped') }}</div>
            <div class="text-2xl font-semibold leading-8" :class="stoppedClass">{{ s.stopped.length }}</div>
          </div>
          <div class="min-w-0 rounded-lg border bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">{{ t('tools.managers.babysitter.accounts') }}</div>
            <div class="text-2xl font-semibold leading-8">{{ s.accounts.length }}</div>
            <p class="truncate text-xs text-muted-foreground">
              {{ t('tools.managers.lastLook') }}: {{ timeAgo(s.checkedAt) }} · {{ t('tools.managers.nextLook') }}: {{ s.nextCheckAt ? new Date(s.nextCheckAt).toLocaleTimeString() : '—' }}
            </p>
          </div>
        </div>

        <h3 class="text-sm font-medium">{{ t('tools.managers.babysitter.chats') }}</h3>
        <p v-if="!s.stopped.length" class="text-sm text-muted-foreground">{{ t('tools.managers.babysitter.noChats') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('tools.managers.babysitter.chatHead') }}</TableHead>
              <TableHead>{{ t('tools.managers.babysitter.stateHead') }}</TableHead>
              <TableHead>{{ t('tools.managers.babysitter.resetHead') }}</TableHead>
              <TableHead>{{ t('tools.managers.babysitter.accountHead') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="c in s.stopped" :key="c.id">
              <TableCell class="max-w-[16rem]" truncate>{{ c.title }}</TableCell>
              <!-- State sits beside the chat so its colour shows without scrolling the table sideways. -->
              <TableCell size="xs" :title="c.reason">
                <span class="inline-flex items-center gap-1.5 font-medium" :class="MANAGER_TEXT_CLASS[babysitterChatDot(c.state)]">
                  <span class="size-2 rounded-full" :class="MANAGER_DOT_CLASS[babysitterChatDot(c.state)]" />
                  {{ t(`tools.managers.babysitter.chatState.${c.state}`, c.state) }}
                </span>
              </TableCell>
              <TableCell size="xs" muted>{{ resetText(c.resetsAt) }}</TableCell>
              <TableCell size="xs">{{ sourceName(c.source) }} · {{ c.account }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <h3 class="text-sm font-medium">{{ t('tools.managers.babysitter.acts') }}</h3>
        <p v-if="!s.acts.length" class="text-sm text-muted-foreground">{{ t('tools.managers.babysitter.noActs') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('tools.managers.babysitter.whenHead') }}</TableHead>
              <TableHead>{{ t('tools.managers.babysitter.chatHead') }}</TableHead>
              <TableHead>{{ t('tools.managers.babysitter.didHead') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="a in s.acts" :key="`${a.at}-${a.id}`">
              <TableCell size="xs" class="whitespace-nowrap">{{ timeAgo(a.at) }}</TableCell>
              <TableCell class="max-w-[16rem]" truncate>{{ a.title }}</TableCell>
              <TableCell size="xs">
                <span class="font-medium" :class="MANAGER_TEXT_CLASS[babysitterActDot(a.did)]">{{ t(`tools.managers.babysitter.did.${a.did}`, a.did) }}</span>
                <span class="text-muted-foreground"> · {{ a.detail }}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </template>
    </CardContent>
  </Card>
</template>

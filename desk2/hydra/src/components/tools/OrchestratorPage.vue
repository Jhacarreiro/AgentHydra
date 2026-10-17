<script setup lang="ts">
// The Orchestrator's page: what its GET route answers (/api/diagnostics/orchestrator): its mode, its last look, the chats it
// looked at, and what it did on its own. Its on/off switch and the model its judge asks are Desk's settings (`orchestrator`,
// `orchestratorModel`, useDeskSettings.ts).
import { ORCHESTRATOR_MODEL_ALIASES, isOrchestratorModel } from '@desk/shared/orchestrator'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useDeskSettings } from '@/composables/useDeskSettings'
import type { Tools } from '@/composables/useTools'
import { EMBEDDED } from '@/lib/desk-embed'
import { timeAgo } from '@/lib/format'

const props = defineProps<{ tools: Tools }>()
const { t } = useI18n()

const p = computed(() => props.tools.orchestrator)

// Desk's settings: the switch and the model row show only inside Desk (EMBEDDED) where Desk's settings route answers.
const desk = useDeskSettings()
const saveError = ref<string | null>(null)
const showSettings = computed(() => EMBEDDED && desk.available === true)
onMounted(() => {
  void desk.refresh()
  void desk.refreshOrchestratorModel()
})

async function setOn(on: boolean) {
  saveError.value = await desk.save({ orchestrator: on })
  void props.tools.refresh()
}

// The model: an alias (the newest of its family), or a full id typed into the custom box (validated, as Desk's Settings did).
const model = computed(() => desk.settings?.orchestratorModel ?? '')
const isAlias = (m: string) => (ORCHESTRATOR_MODEL_ALIASES as readonly string[]).includes(m)
const customOpen = ref(false)
const customDraft = ref('')
// A full model id in the setting shows in the custom box, ready to edit.
watch(
  model,
  (m) => {
    if (m && !isAlias(m)) customDraft.value = m
  },
  { immediate: true },
)
const choice = computed(() => (customOpen.value || !isAlias(model.value) ? 'custom' : model.value))

// Under the row: what the setting runs now (the id the SDK reported once a judgment ran), or the alias it resolves to.
const modelNote = computed(() => {
  const m = model.value
  if (customOpen.value && !isOrchestratorModel(customDraft.value.trim())) return t('tools.managers.orchestrator.model.typeId')
  if (!m) return ''
  const status = desk.orchestratorModel
  if (status?.resolved && status.setting === m) return t('tools.managers.orchestrator.model.runs', { id: status.resolved })
  return isAlias(m) ? t('tools.managers.orchestrator.model.alias', { alias: m }) : t('tools.managers.orchestrator.model.runs', { id: m })
})

async function saveModel(id: string) {
  saveError.value = await desk.save({ orchestratorModel: id })
  void desk.refreshOrchestratorModel()
}
function pickModel(v: string) {
  if (v !== 'custom') {
    customOpen.value = false
    void saveModel(v)
    return
  }
  customOpen.value = true
  customDraft.value = isAlias(model.value) ? '' : model.value
}
function commitCustom() {
  const id = customDraft.value.trim()
  if (!isOrchestratorModel(id) || id === model.value) return
  void saveModel(id)
}
</script>

<template>
  <Card size="sm">
    <CardHeader>
      <div class="flex flex-wrap items-center gap-2">
        <CardTitle size="lg" data-page-title tabindex="-1">{{ t('tools.managers.orchestrator.title') }}</CardTitle>
        <span v-if="p" class="rounded-md border px-1.5 py-0.5 text-xs" :class="p.mode === 'armed' ? 'text-success' : 'text-muted-foreground'">
          {{ p.mode === 'armed' ? t('tools.managers.orchestrator.armed') : t('tools.managers.orchestrator.shadow') }}
        </span>
        <Switch
          v-if="showSettings"
          size="sm"
          class="ms-auto"
          :model-value="desk.settings?.orchestrator ?? false"
          :disabled="desk.saving"
          :aria-label="t('tools.managers.switch.orchestrator')"
          :title="t('tools.managers.switch.orchestrator')"
          @update:model-value="setOn"
        />
      </div>
      <CardDescription>{{ t('tools.managers.orchestrator.caption') }}</CardDescription>
    </CardHeader>
    <CardContent stack="sm">
      <p v-if="tools.error" class="text-xs text-destructive">{{ t('tools.managers.readError', { error: tools.error }) }}</p>
      <p v-if="saveError" class="text-xs text-destructive">{{ t('tools.managers.switch.saveError', { reason: saveError }) }}</p>

      <div v-if="showSettings" class="flex flex-col gap-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm text-muted-foreground">{{ t('tools.managers.orchestrator.model.label') }}</span>
          <Input
            v-if="choice === 'custom'"
            v-model="customDraft"
            type="text"
            class="h-7 w-52 font-mono"
            :aria-label="t('tools.managers.orchestrator.model.customAria')"
            :title="t('tools.managers.orchestrator.model.customAria')"
            :placeholder="t('tools.managers.orchestrator.model.idPlaceholder')"
            @change="commitCustom"
            @keydown.enter="commitCustom"
          />
          <Select :model-value="choice" @update:model-value="(v) => pickModel(String(v))">
            <SelectTrigger class="h-7 w-40" :aria-label="t('tools.managers.orchestrator.model.label')" :title="t('tools.managers.orchestrator.model.label')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end" :side-offset="4">
              <SelectItem value="opus">{{ t('tools.managers.orchestrator.model.opus') }}</SelectItem>
              <SelectItem value="sonnet">{{ t('tools.managers.orchestrator.model.sonnet') }}</SelectItem>
              <SelectItem value="haiku">{{ t('tools.managers.orchestrator.model.haiku') }}</SelectItem>
              <SelectItem value="custom">{{ t('tools.managers.orchestrator.model.custom') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p v-if="modelNote" class="text-2xs text-muted-foreground">{{ modelNote }}</p>
      </div>

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

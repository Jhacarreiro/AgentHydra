<script setup lang="ts">
// Edit a routine's file in place (POST edit): the keys it names are set, the rest stay as the file had them. Only the
// keys that changed are sent. A refusal (409: the result would not check out) shows its reason here and nothing is saved.
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { Routine, RoutinesRequest } from '@desk/shared/routines'

const props = defineProps<{
  routine: Routine
  act: (req: RoutinesRequest) => Promise<string | null>
}>()
const emit = defineEmits<{ done: []; cancel: [] }>()
const { t } = useI18n()

const isPrompt = props.routine.what === 'prompt'
const isRun = props.routine.what === 'run'

const form = reactive({
  name: props.routine.name,
  schedule: props.routine.schedule ?? '',
  prompt: props.routine.prompt ?? '',
  run: (props.routine.command ?? []).join('\n'),
  cwd: props.routine.cwd ?? '',
  timeoutMinutes: String(props.routine.timeoutMinutes ?? 120),
  until: props.routine.until ?? '',
  describe: props.routine.describe,
})
const error = ref<string | null>(null)
const saving = ref(false)

/** The keys whose value changed, as the file's keys (null removes one: an empty `until` or `cwd`). */
function changes(): Record<string, unknown> {
  const r = props.routine
  const set: Record<string, unknown> = {}
  if (form.name.trim() !== r.name) set.name = form.name.trim()
  if (r.schedule !== null && form.schedule.trim() !== r.schedule) set.schedule = form.schedule.trim()
  if (isPrompt && form.prompt !== (r.prompt ?? '')) set.prompt = form.prompt
  if (isRun) {
    const argv = form.run.split('\n').map((x) => x.trim()).filter(Boolean)
    if (argv.join('\n') !== (r.command ?? []).join('\n')) set.run = argv
  }
  if (form.cwd.trim() !== (r.cwd ?? '')) set.cwd = form.cwd.trim() || null
  const minutes = Number(form.timeoutMinutes)
  if (Number.isFinite(minutes) && minutes !== r.timeoutMinutes) set.timeoutMinutes = minutes
  if (form.until.trim() !== (r.until ?? '')) set.until = form.until.trim() || null
  if (form.describe !== r.describe) set.describe = form.describe
  return set
}

async function save() {
  const set = changes()
  if (!Object.keys(set).length) {
    emit('cancel')
    return
  }
  saving.value = true
  error.value = await props.act({ edit: { id: props.routine.id, set } })
  saving.value = false
  if (!error.value) emit('done')
}
</script>

<template>
  <form class="flex flex-col gap-3 rounded-md bg-muted/40 p-3" @submit.prevent="save">
    <h3 class="text-ui font-medium">{{ t('routines.editTitle') }}</h3>

    <label class="flex flex-col gap-1 text-2xs text-muted-foreground">
      {{ t('routines.fieldName') }}
      <Input v-model="form.name" class="text-ui text-foreground" />
    </label>

    <label v-if="routine.schedule !== null" class="flex flex-col gap-1 text-2xs text-muted-foreground">
      {{ t('routines.fieldSchedule') }}
      <Input v-model="form.schedule" class="font-mono text-ui text-foreground" />
    </label>

    <label v-if="isPrompt" class="flex flex-col gap-1 text-2xs text-muted-foreground">
      {{ t('routines.fieldPrompt') }}
      <textarea v-model="form.prompt" rows="6" class="rounded-md border border-input bg-transparent px-2 py-1.5 text-ui text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
    </label>

    <label v-if="isRun" class="flex flex-col gap-1 text-2xs text-muted-foreground">
      {{ t('routines.fieldRun') }}
      <textarea v-model="form.run" rows="4" class="rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-ui text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
    </label>

    <label class="flex flex-col gap-1 text-2xs text-muted-foreground">
      {{ t('routines.fieldCwd') }}
      <Input v-model="form.cwd" class="font-mono text-ui text-foreground" />
    </label>

    <div class="grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1 text-2xs text-muted-foreground">
        {{ t('routines.fieldTimeout') }}
        <Input v-model="form.timeoutMinutes" type="number" min="5" max="360" class="text-ui text-foreground" />
      </label>
      <label class="flex flex-col gap-1 text-2xs text-muted-foreground">
        {{ t('routines.fieldUntil') }}
        <Input v-model="form.until" class="text-ui text-foreground" />
      </label>
    </div>

    <div v-if="routine.kind !== 'windowsTask'" class="flex items-center justify-between gap-3 text-ui">
      {{ t('routines.fieldDescribe') }}
      <Switch v-model="form.describe" />
    </div>

    <p v-if="error" class="text-ui text-destructive">{{ t('routines.editConflict', { reason: error }) }}</p>

    <div class="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" :disabled="saving" @click="emit('cancel')">{{ t('routines.cancel') }}</Button>
      <Button type="submit" size="sm" variant="outline" :disabled="saving">{{ t('routines.save') }}</Button>
    </div>
  </form>
</template>

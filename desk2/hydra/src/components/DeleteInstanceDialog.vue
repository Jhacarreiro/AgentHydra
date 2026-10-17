<script setup lang="ts">
// The one delete confirmation, for every instance table (Claude desktop, Claude CLI, Codex,
// DeepSeek, Free); `namespace` picks the table's own title and wording. It replaced two copies of
// the same dialog.
//
// The gate is a note saying why (owner, 2026-10-16): a login that syncs is deleted on the other PC
// too, and that PC shows the note. The server refuses a note under 3 characters as well.
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { DELETE_DIALOG_KEYS, type DeleteDialogNamespace } from '@/lib/instance-dialog-i18n'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  namespace?: DeleteDialogNamespace
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  /** Emitted once the trimmed note has at least 3 characters. */
  confirm: [note: string]
}>()

const keys = computed(() => DELETE_DIALOG_KEYS[props.namespace ?? 'instances'])
const note = ref('')

watch(open, (isOpen) => {
  if (isOpen) note.value = ''
})

const ready = computed(() => note.value.trim().length >= 3)

function handleSubmit() {
  if (!ready.value) return
  emit('confirm', note.value.trim())
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form @submit.prevent="handleSubmit">
        <DialogHeader>
          <DialogTitle>{{ $t(keys.title) }}</DialogTitle>
          <DialogDescription>{{ $t(keys.description) }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label for="instance-delete-note" class="text-xs font-medium text-muted-foreground">
            {{ $t('instances.deleteDialogNoteLabel') }}
          </label>
          <Textarea
            id="instance-delete-note"
            v-model="note"
            rows="3"
            :disabled="submitting"
            autofocus
          />
          <p class="text-xs text-muted-foreground">{{ $t('instances.deleteDialogNoteHint') }}</p>
          <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" variant="destructive" :disabled="submitting || !ready">
            {{ submitting ? $t(keys.deleting) : $t(keys.submit) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

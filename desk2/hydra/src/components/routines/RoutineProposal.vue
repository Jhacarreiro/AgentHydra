<script setup lang="ts">
// A proposal an AI wrote, waiting for the owner's yes: why it should be a routine, what it would do, who asked for it.
// It never runs until Approve (filled, the one filled button of this page); Discard takes it away.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Hourglass } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { RoutineProposal, RoutinesRequest } from '@desk/shared/routines'

const props = defineProps<{
  proposal: RoutineProposal
  act: (req: RoutinesRequest) => Promise<string | null>
}>()
const { t } = useI18n()

const error = ref<string | null>(null)
const pending = ref<'approve' | 'discard' | null>(null)

// What it would do, in its own words: the prompt, the argv joined, the status command, or the Windows task.
const what = computed(() => {
  const p = props.proposal
  if (p.prompt) return p.prompt
  if (p.run?.length) return p.run.join(' ')
  if (p.status?.length) return p.status.join(' ')
  return p.windowsTask ?? ''
})

async function go(kind: 'approve' | 'discard') {
  pending.value = kind
  error.value = await props.act(kind === 'approve' ? { approve: props.proposal.id } : { discard: props.proposal.id })
  pending.value = null
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <header class="flex flex-col gap-1">
      <span class="inline-flex w-fit items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-2xs text-warning">
        <Hourglass class="size-3.5" aria-hidden="true" />{{ t('routines.folderAwaiting') }}
      </span>
      <h2 class="text-ui font-medium">{{ proposal.name }}</h2>
      <p class="text-ui text-muted-foreground">{{ t('routines.proposalNote') }}</p>
    </header>

    <div class="flex flex-col gap-1">
      <h3 class="text-ui font-medium">{{ t('routines.proposalWhy') }}</h3>
      <p class="text-ui">{{ proposal.why }}</p>
    </div>

    <div class="flex flex-col gap-1">
      <h3 class="text-ui font-medium">{{ t('routines.proposalWhat') }}</h3>
      <pre class="max-h-60 overflow-auto rounded-md bg-muted/40 p-2 text-ui whitespace-pre-wrap">{{ what }}</pre>
    </div>

    <div class="flex flex-col gap-1 text-ui">
      <span class="text-2xs text-muted-foreground">{{ t('routines.askedBy') }}</span>
      <span>{{ proposal.askedBy }}</span>
    </div>

    <p v-if="error" class="text-ui text-destructive">{{ t('routines.actionFailed', { reason: error }) }}</p>

    <div class="flex items-center gap-2">
      <Button size="sm" :disabled="pending !== null" @click="go('approve')">{{ t('routines.approve') }}</Button>
      <Button size="sm" variant="destructive" :disabled="pending !== null" @click="go('discard')">{{ t('routines.discard') }}</Button>
    </div>
  </section>
</template>

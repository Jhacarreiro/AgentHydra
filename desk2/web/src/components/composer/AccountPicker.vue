<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { AccountInfo, AccountRef } from '@shared/protocol'
import { accountShownName } from './logic'
import { Tip } from '@/components/ui/tooltip'
import type { ComposerApi } from './api'

// The account a new session will run on, as a quiet pill at the right end of the env pills. It is
// chosen from the circle under the box (AccountMenu.vue); this only names it.
const props = defineProps<{ modelValue: string; api: ComposerApi; accounts: AccountInfo[] }>()

const fetched = shallowRef<AccountInfo[]>([])
const autoPick = ref<AccountRef | null>(null)

const list = computed(() => (props.accounts.length ? props.accounts : fetched.value))
const current = computed(() => list.value.find((a) => a.id === props.modelValue) ?? null)
const label = computed(() => {
  if (props.modelValue === 'auto') return 'Auto'
  return accountShownName(current.value ?? { id: props.modelValue, label: '' })
})
const hint = computed(() => {
  const pick = autoPick.value ? list.value.find((a) => a.id === autoPick.value!.id) ?? autoPick.value : null
  const now = props.modelValue === 'auto' && pick ? `Auto would pick ${accountShownName(pick)} now. ` : ''
  return `${now}Change it from the circle under the box, on the right.`
})

onMounted(async () => {
  if (!props.accounts.length) {
    try {
      fetched.value = await props.api.accounts()
    } catch {}
  }
})

// The pick is fetched whenever Auto is chosen, also after the profile control switches to it later.
watch(
  () => props.modelValue,
  async (v) => {
    if (v !== 'auto') return
    try {
      const pick = await props.api.pickAccount()
      if (props.modelValue === 'auto') autoPick.value = pick
    } catch {
      autoPick.value = null
    }
  },
  { immediate: true }
)
</script>

<template>
  <Tip :label="hint">
    <span class="flex h-6 min-w-0 shrink items-center truncate px-1.5 text-ui-sm leading-4 text-text-muted" :aria-label="`Account: ${label}`">
      {{ label }}
    </span>
  </Tip>
</template>

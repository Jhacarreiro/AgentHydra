<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Users } from '@lucide/vue'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { loadPeople } from './api'
import PeopleSetup from './PeopleSetup.vue'

// The first-run "Your people": offered once when the people folders are empty. Skipping remembers the choice on
// this machine; Settings → Your people stays reachable.
const SKIPPED = 'ah-people-skipped'
const open = ref(false)

function skip() {
  open.value = false
  try {
    localStorage.setItem(SKIPPED, '1')
  } catch {
    // floor-ok: storage can be off; the dialog then shows again next start, which is harmless
  }
}

onMounted(async () => {
  try {
    if (localStorage.getItem(SKIPPED)) return
    open.value = (await loadPeople()).empty
  } catch {
    // floor-ok: no server answer means no first-run offer
  }
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      v-if="open"
      :show-close-button="false"
      class="max-h-[88vh] gap-0 overflow-y-auto rounded-(--radius-12) p-0 shadow-(--shadow-popover) ring-0 sm:max-w-130"
      @interact-outside.prevent
    >
      <header class="flex items-start gap-3 px-5 pt-5 pb-4">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-(--radius-8) bg-accent text-white" aria-hidden="true"><Users class="size-4" /></span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle class="text-[15px] font-medium leading-5 text-text">Your people</DialogTitle>
          <DialogDescription class="text-ui-sm leading-4 text-text-muted">Who you work with. Change any of it later in Settings.</DialogDescription>
        </div>
      </header>
      <div class="px-5 pb-5"><PeopleSetup skippable @skip="skip" /></div>
    </DialogContent>
  </Dialog>
</template>

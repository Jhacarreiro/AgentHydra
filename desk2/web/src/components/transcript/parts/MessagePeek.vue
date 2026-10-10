<script setup lang="ts">
// The peek under the transcript's step arrows (owner, 2026-10-10: "instead of scrolling to the top, it will kind of
// just ... show me what the previous message was in ... a slide-down tray. Kind of like the Session details thing
// works"). It slides down over the transcript's top with the message the up arrow would go to, and the view stays
// where it is. It stays PEEK_MS, as long as the pointer is on it, and AFTER_HOVER_MS once the pointer leaves, the
// header peek's timings (session-header/state.ts). Go to it glides there as the arrow does.
import { onBeforeUnmount, ref, watch } from 'vue'
import type { TranscriptItem } from '@shared/protocol'

const PEEK_MS = 2000
const AFTER_HOVER_MS = 1000

const props = defineProps<{
  /** The message to show; null hides the tray. */
  item: Extract<TranscriptItem, { kind: 'user' }> | null
  /** How far down the transcript's top the tray starts: what the session header covers. */
  top: number
}>()
const emit = defineEmits<{ close: []; go: [] }>()

let timer: ReturnType<typeof setTimeout> | null = null
const held = ref(false)
function arm(ms: number) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (!held.value) emit('close')
  }, ms)
}
function disarm() {
  if (timer) clearTimeout(timer)
  timer = null
}
watch(
  () => props.item?.id,
  (id) => {
    held.value = false
    if (id) arm(PEEK_MS)
    else disarm()
  },
  { immediate: true },
)
function hold(on: boolean) {
  held.value = on
  if (on) disarm()
  else arm(AFTER_HOVER_MS)
}
onBeforeUnmount(disarm)
</script>

<template>
  <div class="pointer-events-none absolute inset-x-0 z-[9] overflow-hidden" :style="{ top: `${top}px` }">
    <Transition
      enter-from-class="-translate-y-full opacity-0"
      leave-to-class="-translate-y-full opacity-0"
      enter-active-class="transition duration-220 ease-(--ease-snap) motion-reduce:transition-none"
      leave-active-class="transition duration-220 ease-(--ease-snap) motion-reduce:transition-none"
    >
      <section
        v-if="item"
        :key="item.id"
        class="pointer-events-auto border-b border-border bg-bg-page py-2 ps-4 pe-14 shadow-(--shadow-menu-ringed)"
        role="status"
        aria-label="Previous message you sent"
        data-testid="message-peek"
        @pointerenter="hold(true)"
        @pointerleave="hold(false)"
        @keydown.esc="emit('close')"
      >
        <div class="mb-1 flex items-center gap-2 text-[12px] text-text-muted">
          <span>Previous message you sent</span>
          <button
            type="button"
            class="rounded-(--radius-6) px-1.5 py-0.5 text-text-2 transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text"
            @click="emit('go')"
          >Go to it</button>
        </div>
        <p class="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words text-[14px] leading-5 text-text">{{ item.text }}</p>
        <p v-if="item.images?.length" class="mt-1 text-[12px] text-text-muted">
          {{ item.images.length === 1 ? 'And 1 image' : `And ${item.images.length} images` }}
        </p>
      </section>
    </Transition>
  </div>
</template>

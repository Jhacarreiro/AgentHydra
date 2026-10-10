<script setup lang="ts">
// The peek under the transcript's step arrows (owner, 2026-10-10: "instead of scrolling to the top, it will kind of
// just ... show me what the previous message was in ... a slide-down tray. Kind of like the Session details thing
// works"). It slides down over the transcript's top with the message the up arrow would go to, and the view stays
// where it is. It stays PEEK_MS, as long as the pointer is on it, and AFTER_HOVER_MS once the pointer leaves, the
// header peek's timings (session-header/state.ts). Go to it glides there as the arrow does.
// The message sits in the sent bubble's lighter grey (transcript.css .tx-bubble), clamped at its height with a fade and
// Read more (owner, 2026-10-10: "sometimes it's too big. It needs to cap off a little bit better with a 'read more.' ...
// a lighter gray bubble, so it ... feels proper"); read in full, it scrolls inside the tray.
import { useResizeObserver } from '@vueuse/core'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
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
const body = ref<HTMLElement | null>(null)
const long = ref(false)
const expanded = ref(false)
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
  async (id) => {
    held.value = false
    expanded.value = false
    long.value = false
    if (id) arm(PEEK_MS)
    else disarm()
    await nextTick()
    measure()
  },
  { immediate: true },
)
// Clamped or not, measured again when the window narrows or widens under an open peek; read in full, Read less stays.
function measure() {
  const el = body.value
  if (!expanded.value) long.value = !!el && el.scrollHeight > el.clientHeight + 1
}
useResizeObserver(body, measure)
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
        <div class="tx-bubble w-fit">
          <p
            ref="body"
            class="whitespace-pre-wrap wrap-break-word"
            :class="expanded ? 'max-h-[40vh] overflow-y-auto' : ['tx-bubble-clamped', long && 'tx-bubble-fade']"
          >{{ item.text }}</p>
          <button v-if="long" type="button" class="tx-bubble-more" :aria-expanded="expanded" @click="expanded = !expanded">
            {{ expanded ? 'Read less' : 'Read more' }}
          </button>
        </div>
        <p v-if="item.images?.length" class="mt-1 text-[12px] text-text-muted">
          {{ item.images.length === 1 ? 'And 1 image' : `And ${item.images.length} images` }}
        </p>
      </section>
    </Transition>
  </div>
</template>

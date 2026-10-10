<script setup lang="ts">
import { computed } from 'vue'
import { glyphDotClass, glyphRingClass, type StatusGlyph } from './logic'

// The compact mode's lead (compact.ts): a row's project icon where its status dot was, inside a squircle ring when the
// chat has something going on (glyphRingClass). The ring is 22px and 2px wide, cut out of a gradient with a mask so the
// 1px gap before the 16px icon shows whatever is under the row (a selected or hovered row's fill too), and only the
// ring blinks or pulses, never the icon. A row keeps its 26px height. A project with no icon (the group header's
// fallback) keeps the dot in the middle, so the state still shows.
const props = defineProps<{ glyph: StatusGlyph; icon: string | null }>()
const ring = computed(() => glyphRingClass(props.glyph))
</script>

<template>
  <span role="img" :aria-label="glyph.label" class="relative flex size-5.5 shrink-0 items-center justify-center">
    <span
      v-if="ring"
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 rounded-[7px] p-0.5 [mask:linear-gradient(#000_0_0)_content-box_exclude,linear-gradient(#000_0_0)]"
      :class="ring"
    />
    <img v-if="icon" :src="icon" alt="" class="size-4 rounded-[3px]" />
    <span v-else class="size-1.5 rounded-full" :class="glyphDotClass({ shape: glyph.shape, tone: glyph.tone, motion: 'none' })" />
  </span>
</template>

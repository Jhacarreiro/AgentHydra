<script setup lang="ts">
// An html file a reply shows as a live preview: the page in a sandboxed frame (no script, no origin of the
// window's, no forms or popups), white like the paper it is, full message width. Expand makes it taller; Phone
// narrows it to a phone's width, to see a marketing email as its recipients will on a phone.
import { ref } from 'vue'

const props = defineProps<{ src: string; name?: string }>()

const big = ref(false)
const phone = ref(false)
</script>

<template>
  <div class="html-preview" :class="{ 'is-big': big, 'is-phone': phone }" data-testid="html-preview">
    <div class="html-preview-bar">
      <span class="html-preview-name">{{ name || 'Preview' }}</span>
      <button type="button" class="html-preview-btn" :aria-pressed="phone" @click="phone = !phone">Phone</button>
      <button type="button" class="html-preview-btn" :aria-expanded="big" @click="big = !big">{{ big ? 'Smaller' : 'Expand' }}</button>
    </div>
    <iframe class="html-preview-frame" :src="props.src" sandbox="" :title="name || 'Preview'" loading="lazy"></iframe>
  </div>
</template>

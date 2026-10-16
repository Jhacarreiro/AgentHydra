<script setup lang="ts">
// One attachment as a 120px square: the thumbnail (a picture, a PDF's first page, or nothing for a plain file) fills it,
// the file type sits top left, and the name and size sit on a soft scrim at the foot. Shared by the message box and the
// sent message so both look the same.
import { computed } from 'vue'
import './attachment-tile.css'

const props = defineProps<{ name: string; size?: string; as?: 'button' | 'div'; revealPath?: string }>()

const typeLabel = computed(() => /\.([A-Za-z0-9]{1,5})$/.exec(props.name)?.[1]?.toUpperCase() ?? 'FILE')
</script>

<template>
  <component :is="as ?? 'div'" :type="as === 'button' ? 'button' : undefined" class="attachment-tile" :data-reveal-path="revealPath">
    <slot />
    <span class="attachment-type">{{ typeLabel }}</span>
    <span class="attachment-caption">
      <span class="attachment-name">{{ name || 'file' }}</span>
      <span v-if="size" class="attachment-size">{{ size }}</span>
    </span>
  </component>
</template>

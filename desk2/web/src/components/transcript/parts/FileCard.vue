<script setup lang="ts">
// The real file card (real-markdown-and-file-card.png): 120x120, r8, #20201f with a 1px white-20% ring,
// a type badge top left ("PNG", 18 high, the same ring), the name (13px primary) and size (12px
// secondary) at the bottom. A picture opens in the lightbox. A PDF shows its first page instead, once rendered.
import { computed } from 'vue'
import type { ImageRef } from '@shared/protocol'
import { fileBadge, formatSize, imageSrc, openLightbox, pdfSrc } from '../lib/media'
import PdfTile from '../../media/PdfTile.vue'

const props = defineProps<{ file: ImageRef }>()

const pdfUrl = computed(() => pdfSrc(props.file))

function open() {
  const src = imageSrc(props.file)
  if (src) openLightbox(src, props.file.name ?? '')
}
</script>

<template>
  <PdfTile
    v-if="pdfUrl"
    :source="pdfUrl"
    :cache-key="pdfUrl"
    :height="120"
    :name="file.name || 'file'"
    :size-label="formatSize(file.bytes)"
    :reveal-path="file.path"
  >
    <div class="tx-file-card" :data-reveal-path="file.path">
      <span class="tx-file-badge">{{ fileBadge(file) }}</span>
      <span class="mt-auto flex w-full min-w-0 flex-col items-start">
        <span class="w-full truncate text-start text-[13px] leading-4.5 text-text">{{ file.name || 'file' }}</span>
        <span class="text-[12px] leading-4 text-text-2 tabular-nums">{{ formatSize(file.bytes) }}</span>
      </span>
    </div>
  </PdfTile>
  <component
    :is="imageSrc(file) ? 'button' : 'div'"
    v-else
    :type="imageSrc(file) ? 'button' : undefined"
    class="tx-file-card"
    :data-reveal-path="file.path"
    :aria-label="imageSrc(file) ? `Open ${file.name || 'file'}` : undefined"
    @click="open"
  >
    <span class="tx-file-badge">{{ fileBadge(file) }}</span>
    <span class="mt-auto flex w-full min-w-0 flex-col items-start">
      <span class="w-full truncate text-start text-[13px] leading-4.5 text-text">{{ file.name || 'file' }}</span>
      <span class="text-[12px] leading-4 text-text-2 tabular-nums">{{ formatSize(file.bytes) }}</span>
    </span>
  </component>
</template>

<script setup lang="ts">
// A file as an attachment tile: a picture opens in the lightbox, a PDF shows its first page once rendered.
import { computed } from 'vue'
import type { ImageRef } from '@shared/protocol'
import { formatSize, imageSrc, openLightbox, pdfSrc } from '../lib/media'
import PdfTile from '../../media/PdfTile.vue'
import AttachmentTile from '../../media/AttachmentTile.vue'

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
    <AttachmentTile :name="file.name || 'file'" :size="formatSize(file.bytes)" :reveal-path="file.path" />
  </PdfTile>
  <AttachmentTile
    v-else
    :as="imageSrc(file) ? 'button' : 'div'"
    :name="file.name || 'file'"
    :size="formatSize(file.bytes)"
    :reveal-path="file.path"
    :aria-label="imageSrc(file) ? `Open ${file.name || 'file'}` : undefined"
    @click="open"
  />
</template>

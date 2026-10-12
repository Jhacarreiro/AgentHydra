<script setup lang="ts">
// A PDF as its first page in an attachment tile, the page filling it from the top. Until the page is rendered, or when it
// cannot be (encrypted, broken, too slow), the slot shows: the file tile the PDF had before.
import { ref, watch } from 'vue'
import { pdfFirstPageThumb } from '../../lib/pdf-thumb'
import { renderPdfFirstPage } from '../../lib/pdf-render'
import AttachmentTile from './AttachmentTile.vue'

const props = defineProps<{
  source: string | Blob | null | undefined
  cacheKey: string
  height: number
  name: string
  sizeLabel: string
  revealPath?: string
}>()

const thumb = ref<string | null>(null)

let latest = 0
watch(
  () => [props.source, props.cacheKey, props.height] as const,
  async ([source, key, height]) => {
    const run = ++latest
    thumb.value = null
    if (!source) return
    const url = await pdfFirstPageThumb(key, height, () => renderPdfFirstPage(source, height))
    if (run === latest) thumb.value = url
  },
  { immediate: true },
)
</script>

<template>
  <AttachmentTile v-if="thumb" :name="name" :size="sizeLabel" :reveal-path="revealPath" data-testid="pdf-tile">
    <img :src="thumb" alt="" draggable="false" class="block size-full object-cover object-top" />
  </AttachmentTile>
  <slot v-else />
</template>

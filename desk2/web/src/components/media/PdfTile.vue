<script setup lang="ts">
// A PDF as its first page, a portrait tile as tall as the picture tiles beside it, with a PDF badge and the name and
// size on a bar at the foot. Until the page is rendered, or when it cannot be (encrypted, broken, too slow), the slot
// shows: the file chip or card the PDF had before.
import { computed, ref, watch } from 'vue'
import { pdfFirstPageThumb } from '../../lib/pdf-thumb'
import { renderPdfFirstPage } from '../../lib/pdf-render'

const props = defineProps<{
  source: string | Blob | null | undefined
  cacheKey: string
  height: number
  name: string
  sizeLabel: string
}>()

const thumb = ref<string | null>(null)
const width = computed(() => Math.round(props.height / Math.SQRT2))

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
  <div
    v-if="thumb"
    class="relative shrink-0 overflow-hidden rounded-(--radius-8) bg-(--bg-picture) shadow-(--shadow-picture-light)"
    :style="{ width: `${width}px`, height: `${height}px` }"
    data-testid="pdf-tile"
  >
    <img :src="thumb" alt="" draggable="false" class="block size-full object-cover object-top" />
    <span class="absolute left-1.5 top-1.5 rounded-sm bg-black/60 px-1 text-[10px] leading-4 font-semibold text-white">PDF</span>
    <span class="absolute inset-x-0 bottom-0 flex min-w-0 flex-col bg-black/70 px-1.5 py-1 text-white">
      <span class="truncate text-[11px] leading-4">{{ name }}</span>
      <span class="text-[10px] leading-3.5 text-white/75 tabular-nums">{{ sizeLabel }}</span>
    </span>
  </div>
  <slot v-else />
</template>

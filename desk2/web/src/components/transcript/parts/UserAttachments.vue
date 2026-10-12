<script setup lang="ts">
// A user's attachments as fixed 120px squares in a row on the bubble's side, as Claude and Codex show them: a picture
// fills its square (a tall page from its top), a PDF shows its first page, any other file is a file card. A tile opens
// the viewer on click or Space; the viewer steps through this message's pictures.
import { computed, ref } from 'vue'
import type { ImageRef } from '@shared/protocol'
import FileCard from './FileCard.vue'
import { imageSrc, openLightbox, tileKey } from '../lib/media'
import { attachmentTile } from '../../../lib/picture-tile'

const props = defineProps<{ images: ImageRef[] }>()

const natural = ref<Record<number, { w: number; h: number }>>({})

const pictures = computed(() => props.images.flatMap((img, i) => (imageSrc(img) ? [{ i, src: imageSrc(img)!, alt: img.name ?? '' }] : [])))

function tile(i: number) {
  return attachmentTile(natural.value[i]?.w ?? 0, natural.value[i]?.h ?? 0)
}
function onLoad(i: number, e: Event) {
  const el = e.target as HTMLImageElement
  natural.value = { ...natural.value, [i]: { w: el.naturalWidth, h: el.naturalHeight } }
}
function open(src: string, alt: string) {
  openLightbox(
    src,
    alt,
    pictures.value.map((p) => ({ src: p.src, alt: p.alt })),
  )
}
</script>

<template>
  <div class="flex w-full flex-wrap justify-end gap-1.5" data-testid="image-gallery">
    <template v-for="(img, i) in images" :key="i">
      <button
        v-if="imageSrc(img)"
        type="button"
        class="block cursor-zoom-in overflow-hidden rounded-(--radius-8) bg-(--bg-picture) shadow-(--shadow-picture-light)"
        :data-reveal-path="img.path"
        :style="{ width: `${tile(i).size}px`, height: `${tile(i).size}px` }"
        :aria-label="`Open ${img.name || 'picture'}`"
        @click="open(imageSrc(img)!, img.name ?? '')"
        @keydown="tileKey($event, () => open(imageSrc(img)!, img.name ?? ''))"
        @keyup="tileKey($event, () => {})"
      >
        <img
          :src="imageSrc(img)!"
          :alt="img.name || 'picture'"
          loading="lazy"
          class="block size-full object-cover"
          :style="{ objectPosition: tile(i).objectPosition }"
          @load="onLoad(i, $event)"
        />
      </button>
      <FileCard v-else :file="img" />
    </template>
  </div>
</template>

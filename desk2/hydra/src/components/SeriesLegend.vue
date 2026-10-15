<script setup lang="ts">
// The colour key under a chart's series: one swatch and label per series, in the order given.
defineProps<{ series: Array<{ key: string; label: string; color: string }> }>()
</script>

<template>
  <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted-foreground">
    <li v-for="s in series" :key="s.key" class="flex items-center gap-1">
      <span class="inline-block size-2 rounded-sm bg-(--dot-c)" :style="{ '--dot-c': s.color }"></span>
      {{ s.label }}
    </li>
  </ul>
</template>

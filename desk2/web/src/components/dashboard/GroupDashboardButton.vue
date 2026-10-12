<script setup lang="ts">
import { computed } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { HEADER_BTN } from '@/components/sidebar/rowClasses'
import { DashboardGlyph } from './glyph'
import { hasSite } from './logic'
import { dashboardList, openDashboard } from './store'

// A sidebar group's dashboard button, beside its New session +: only for a project whose chats wrote a site (the desk list
// and the cloud list each draw one per group head; the sidebar keeps dashboardList fresh).
const props = defineProps<{ folder: string | null; label: string }>()
const shown = computed(() => !!props.folder && hasSite(dashboardList.value, props.folder))
</script>

<template>
  <Tip v-if="shown" :label="`Open the ${label} dashboard`">
    <button type="button" :class="HEADER_BTN" :aria-label="`Open the ${label} dashboard`" @click="openDashboard(folder!)">
      <DashboardGlyph class="size-3.5" aria-hidden="true" />
    </button>
  </Tip>
</template>

<script setup lang="ts">
// The sus level as a chip that opens a menu, as the model's name does (owner, 2026-10-15: "change this to chill/sus/sketch
// and make it a flyout selector like the model selector is"). What each level does is its row's hover text.
import { ref } from 'vue'
import { SUS_LEVELS, type SusLevel } from '@shared/protocol'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { icons } from '@/lib/icons'
import { HEADER, ITEM, MENU } from './menu'
import { SUS_LABEL, SUS_TIP } from './sus'

const props = defineProps<{ level: SusLevel; nonModal?: boolean }>()
const emit = defineEmits<{ pick: [level: SusLevel] }>()

const Check = icons.check
const open = ref(false)
const CHIP =
  'shrink-0 cursor-pointer whitespace-nowrap rounded-[var(--radius-5)] px-1.5 text-ui-sm leading-[18px] transition-colors duration-[60ms] hover:bg-(--fill-secondary) data-[state=open]:bg-(--fill-secondary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-text)'
const TONE: Record<SusLevel, string> = {
  fine: 'text-(--text-muted) hover:text-(--text) data-[state=open]:text-(--text)',
  sus: 'bg-(--warning-bg) text-(--warning-text)',
  bad: 'bg-(--danger-bg) text-(--danger-text)',
}

function pick(level: SusLevel) {
  if (level !== props.level) emit('pick', level)
}
</script>

<template>
  <!-- The Tip wraps the whole menu, never the trigger alone (test/lib/tip-structure.test.ts). -->
  <Tip :label="SUS_TIP[level]" side="top">
    <span class="inline-flex">
      <DropdownMenu v-model:open="open" :modal="!nonModal">
        <DropdownMenuTrigger as-child>
          <button type="button" :class="[CHIP, TONE[level]]" :aria-label="`Sus level: ${SUS_LABEL[level]}. Change it`" data-composer-sus>
            {{ SUS_LABEL[level] }}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" :side-offset="6" :class="MENU" data-composer-menu="sus">
          <div role="presentation" :class="HEADER">Sus level</div>
          <DropdownMenuItem
            v-for="s in SUS_LEVELS"
            :key="s"
            role="menuitemradio"
            :aria-checked="level === s"
            :class="ITEM"
            :title="SUS_TIP[s]"
            :data-sus="s"
            @select="pick(s)"
          >
            <span class="flex-1 whitespace-nowrap">{{ SUS_LABEL[s] }}</span>
            <Check v-if="level === s" class="ms-3 size-3.5 text-(--accent)" :stroke-width="3" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  </Tip>
</template>

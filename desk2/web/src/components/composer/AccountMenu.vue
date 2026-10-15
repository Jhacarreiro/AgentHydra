<script setup lang="ts">
// The circle at the right end of the toolbar opens the account menu (owner, 2026-10-15: "if I click the little circle ...
// show me the account selector ... only show desktop instances ... pin the orchestrator to a single account. And then have
// a little toggle in there that says Auto"). Its rows are the logins linked to a Claude Desktop instance, each by the name
// on the account, never a folder's; Auto moves the chat on when its account runs out, and off it waits there for the
// reset. The menu holds only the choices, its check beside the chosen name so no column sits empty (owner: "Keep the menu
// clean ... There seems to be a gap on the right"); what Auto does, and why a chat cannot move, is in the hover text.
import { computed, ref } from 'vue'
import type { AccountInfo, AccountRef } from '@shared/protocol'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { icons } from '@/lib/icons'
import ContextRing from './ContextRing.vue'
import { accountShownName, accountUsedPct, menuAccounts } from './logic'
import { HEADER, ITEM, MENU, SEPARATOR, SHORTCUT, TOOL_ICON } from './menu'

const props = defineProps<{
  accounts: AccountInfo[]
  /** The account the chat is on, or the one a new session will run on; null while 'auto' has placed nothing yet. */
  current: AccountRef | null
  /** Placed by 'auto': any account with room. */
  auto: boolean
  /** Auto off: the chat waits for its own account's reset instead of moving on. */
  pinned: boolean
  contextPct: number | null
  /** Why the account cannot be changed here; the rows show but do nothing, and the hover text says why. */
  locked?: string
  /** Where a send goes (an outside chat continues as a copy, and on which account), said in the hover text. */
  hint?: string
  nonModal?: boolean
}>()
const emit = defineEmits<{ pick: [id: string]; auto: [on: boolean] }>()

const Check = icons.check
const CHECK = 'size-3.5 shrink-0 text-(--accent)'
const open = ref(false)

const rows = computed(() => menuAccounts(props.accounts, props.current?.id ?? null))
const currentName = computed(() => {
  const now = props.current
  return now ? accountShownName(props.accounts.find((a) => a.id === now.id) ?? now) : null
})
const isCurrent = (a: AccountInfo): boolean => !props.auto && props.current?.id === a.id
function rowNote(a: AccountInfo): string {
  if (!a.signedIn) return 'signed out'
  const used = accountUsedPct(a)
  return [a.plan, used === null ? null : `${used}%`].filter(Boolean).join(' · ')
}
function rowTitle(a: AccountInfo): string {
  const pct = (p: number | null) => (p === null ? 'not read' : `${Math.round(p)}% used`)
  return `${accountShownName(a)}: 5-hour ${pct(a.fiveHourPct)}, week ${pct(a.weeklyPct)}`
}
const autoTitle = computed(() =>
  props.pinned ? 'Off: this chat waits for its account when it runs out' : 'On: this chat moves to the next account with room when its account runs out'
)
const tip = computed(() => {
  const on = props.auto ? `any account with room${currentName.value ? `, now ${currentName.value}` : ''}` : (currentName.value ?? 'any account with room')
  return [`Account: ${on}${props.pinned ? ' (stays on it)' : ''}`, props.hint, props.locked].filter(Boolean).join('\n')
})
</script>

<template>
  <Tip :label="tip" side="top">
    <span class="inline-flex">
      <DropdownMenu v-model:open="open" :modal="!nonModal">
        <DropdownMenuTrigger as-child>
          <button type="button" :class="TOOL_ICON" :aria-label="`Account: ${currentName ?? 'any account with room'}. Change it`" data-composer-account>
            <ContextRing :pct="contextPct" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" :side-offset="6" :class="[MENU, 'min-w-60']" data-composer-menu="account">
          <div role="presentation" :class="HEADER">Account</div>
          <DropdownMenuItem role="menuitemradio" :aria-checked="auto" :disabled="!!locked" :class="ITEM" @select="emit('pick', 'auto')">
            <span class="min-w-0 truncate">Any account with room</span>
            <Check v-if="auto" :class="CHECK" :stroke-width="3" />
          </DropdownMenuItem>
          <DropdownMenuItem
            v-for="a in rows"
            :key="a.id"
            role="menuitemradio"
            :aria-checked="isCurrent(a)"
            :disabled="!!locked || !a.signedIn"
            :class="ITEM"
            :title="rowTitle(a)"
            @select="emit('pick', a.id)"
          >
            <span class="min-w-0 truncate">{{ accountShownName(a) }}</span>
            <Check v-if="isCurrent(a)" :class="CHECK" :stroke-width="3" />
            <span :class="SHORTCUT">{{ rowNote(a) }}</span>
          </DropdownMenuItem>
          <p v-if="!rows.length" class="px-2 py-1 text-ui-sm leading-4 text-(--text-muted)">No login is linked to a Claude Desktop instance yet.</p>
          <div role="separator" :class="SEPARATOR" />
          <DropdownMenuItem
            role="menuitemcheckbox"
            :aria-checked="!pinned"
            :disabled="!!locked"
            :class="ITEM"
            :title="autoTitle"
            data-composer-auto
            @select.prevent="emit('auto', pinned)"
          >
            <span class="flex-1">Auto</span>
            <span class="relative h-3.5 w-6 shrink-0 rounded-full transition-colors" :class="pinned ? 'bg-(--fill-secondary)' : 'bg-(--accent)'" aria-hidden="true">
              <span class="absolute top-0.5 size-2.5 rounded-full bg-white transition-[left]" :class="pinned ? 'left-0.5' : 'left-3'" />
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  </Tip>
</template>

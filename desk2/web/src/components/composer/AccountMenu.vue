<script setup lang="ts">
// The context ring at the right end of the toolbar opens the account menu (owner, 2026-10-15: "if I click the little
// circle ... show me the account selector ... only show desktop instances ... pin the orchestrator to a single account.
// And then have a little toggle in there that says Auto"). Its rows are the logins linked to a Claude Desktop instance,
// by that instance's name; Auto moves the chat on when its account runs out, and off it waits there for the reset.
import { computed, ref } from 'vue'
import type { AccountInfo, AccountRef } from '@shared/protocol'
import { accountTitle } from '@/components/accounts/format'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { icons } from '@/lib/icons'
import ContextRing from './ContextRing.vue'
import { accountUsedPct, menuAccounts } from './logic'
import { DESCRIPTION, HEADER, ITEM, ITEM_TALL, MENU, SEPARATOR, SHORTCUT, TOOL_ICON } from './menu'

const props = defineProps<{
  accounts: AccountInfo[]
  /** The account the chat is on, or the one a new session will run on; null while 'auto' has placed nothing yet. */
  current: AccountRef | null
  /** Placed by 'auto': any account with room. */
  auto: boolean
  /** Auto off: the chat waits for its own account's reset instead of moving on. */
  pinned: boolean
  contextPct: number | null
  /** Why the account cannot be changed here; the rows show but do nothing. */
  locked?: string
  nonModal?: boolean
}>()
const emit = defineEmits<{ pick: [id: string]; auto: [on: boolean] }>()

const Check = icons.check
const open = ref(false)

const rows = computed(() => menuAccounts(props.accounts, props.current?.id ?? null))
const info = computed(() => (props.current ? props.accounts.find((a) => a.id === props.current!.id) : undefined))
const nameOf = (a: AccountInfo | AccountRef): string => ('desktop' in a && a.desktop) || accountTitle(a)
const currentName = computed(() => (info.value ? nameOf(info.value) : props.current ? accountTitle(props.current) : null))
const isCurrent = (a: AccountInfo): boolean => !props.auto && props.current?.id === a.id
function rowNote(a: AccountInfo): string {
  if (!a.signedIn) return 'signed out'
  const used = accountUsedPct(a)
  return [a.plan, used === null ? null : `${used}%`].filter(Boolean).join(' · ')
}
function rowTitle(a: AccountInfo): string {
  const pct = (p: number | null) => (p === null ? 'not read' : `${Math.round(p)}% used`)
  return `${accountTitle(a)}: 5-hour ${pct(a.fiveHourPct)}, week ${pct(a.weeklyPct)}`
}
const autoLine = computed(() => (props.auto && currentName.value ? `Now on ${currentName.value}` : 'Picks the one with the most room'))
const contextText = computed(() =>
  props.contextPct == null ? 'Context not measured yet' : `Context: ${Math.round(props.contextPct)}% of the window used`
)
const tip = computed(() => {
  const on = props.auto ? `Any account${currentName.value ? `, now ${currentName.value}` : ''}` : (currentName.value ?? 'Any account')
  return `Account: ${on}${props.pinned ? ' (stays on it)' : ''}\n${contextText.value}`
})
</script>

<template>
  <Tip :label="tip" side="top">
    <span class="inline-flex">
      <DropdownMenu v-model:open="open" :modal="!nonModal">
        <DropdownMenuTrigger as-child>
          <button type="button" :class="TOOL_ICON" :aria-label="`Account: ${currentName ?? 'any account'}. ${contextText}. Change the account`" data-composer-account>
            <ContextRing :pct="contextPct" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" :side-offset="6" :class="[MENU, 'w-72']" data-composer-menu="account">
          <div role="presentation" :class="HEADER">Account</div>
          <p v-if="locked" class="px-2 pb-1.5 text-ui-sm leading-4 text-(--text-muted)">{{ locked }}</p>
          <DropdownMenuItem role="menuitemradio" :aria-checked="auto" :disabled="!!locked" :class="[ITEM, ITEM_TALL]" @select="emit('pick', 'auto')">
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">Any account with room</span>
              <span class="truncate" :class="DESCRIPTION">{{ autoLine }}</span>
            </span>
            <Check v-if="auto" class="ms-2 size-3.5 shrink-0 text-(--accent)" :stroke-width="3" />
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
            <span class="min-w-0 flex-1 truncate">{{ nameOf(a) }}</span>
            <span :class="SHORTCUT">{{ rowNote(a) }}</span>
            <Check v-if="isCurrent(a)" class="ms-2 size-3.5 shrink-0 text-(--accent)" :stroke-width="3" />
            <span v-else class="ms-2 size-3.5 shrink-0" aria-hidden="true" />
          </DropdownMenuItem>
          <p v-if="!rows.length" class="px-2 py-1 text-ui-sm leading-4 text-(--text-muted)">No login is linked to a Claude Desktop instance yet.</p>
          <div role="separator" :class="SEPARATOR" />
          <DropdownMenuItem
            role="menuitemcheckbox"
            :aria-checked="!pinned"
            :disabled="!!locked"
            :class="[ITEM, ITEM_TALL]"
            data-composer-auto
            @select.prevent="emit('auto', pinned)"
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <span>Auto</span>
              <span class="truncate" :class="DESCRIPTION">{{ pinned ? 'Waits here when this account runs out' : 'Moves on when this account runs out' }}</span>
            </span>
            <span class="relative ms-2 h-3.5 w-6 shrink-0 rounded-full transition-colors" :class="pinned ? 'bg-(--fill-secondary)' : 'bg-(--accent)'" aria-hidden="true">
              <span class="absolute top-0.5 size-2.5 rounded-full bg-white transition-[left]" :class="pinned ? 'left-0.5' : 'left-3'" />
            </span>
          </DropdownMenuItem>
          <div role="separator" :class="SEPARATOR" />
          <p class="px-2 py-1 text-ui-sm leading-4 text-(--text-muted)">{{ contextText }}</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  </Tip>
</template>

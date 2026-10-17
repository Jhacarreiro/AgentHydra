// The Settings dialog's button, text-field, menu and segmented-control looks, shared by its own rows, the AgentHydra rows,
// the Instances rows and the Routines cards; and the arrow keys of a segmented control.
import { ITEM, MENU } from '@/components/composer/menu'

/** A segmented control: the radiogroup, and each of its radios. */
export const SEGMENTS = 'flex h-7 shrink-0 items-center gap-px rounded-[var(--radius-7)] bg-fill-5 p-px'
export const SEGMENT =
  'flex h-[26px] cursor-default items-center rounded-[var(--radius-5)] px-2.5 text-ui leading-[19px] text-text-2 transition-colors duration-[60ms] hover:text-text focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none aria-checked:bg-[var(--fill-secondary)] aria-checked:text-text'

/** The arrow keys on a segmented control: pick the next or previous radio (wrapping) and move the focus to it. */
export function onSegmentKey(e: KeyboardEvent, current: number, count: number, pick: (i: number) => void) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  e.preventDefault()
  const next = (current + step + count) % count
  pick(next)
  const group = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')
  group[next]?.focus()
}

export const BUTTON =
  'flex h-7 shrink-0 cursor-default items-center rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2.5 text-ui text-text transition-colors duration-[60ms] hover:bg-[var(--fill-secondary-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50'
export const FIELD =
  'h-7 rounded-[var(--radius-6)] bg-fill-5 px-2 text-ui text-text shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[var(--focus-ring)]'
export const SELECT_TRIGGER =
  'h-7 w-48 gap-1 rounded-[var(--radius-6)] border-0 bg-fill-5 px-2 text-ui leading-[19px] text-text shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover data-[state=open]:bg-fill-hover focus-visible:ring-0 focus-visible:shadow-[var(--focus-ring)]'
export const SELECT_CONTENT = MENU + ' border-0'
export const SELECT_ITEM = ITEM + ' pr-8 text-text focus:text-text'

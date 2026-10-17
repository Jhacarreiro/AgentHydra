import type { SusLevel, SusPick } from '@shared/protocol'
import { modelTriggerLabel } from './logic'

/** The turns a setting needs before 'sus' routes to it; below that 'sus' runs on the normal model (server SUS_MIN_TURNS). */
export const SUS_LEARNING_TURNS = 20

// Said as Chill, Sus and Sketch (owner, 2026-10-15: "change this to chill/sus/sketch"); the stored levels keep their ids.
export const SUS_LABEL: Record<SusLevel, string> = { fine: 'Chill', sus: 'Sus', bad: 'Sketch' }

/** What each level does, on hover (owner, 2026-10-15: "when I hover over those, they explain what each one does"). */
export const SUS_TIP: Record<SusLevel, string> = {
  fine: 'Chill: the chat runs on the model you pick beside this.',
  sus: `Sus: the chat runs on whichever model and effort has pushed back least on your work (refusals, "are you sure", lectures). Until one has ${SUS_LEARNING_TURNS} counted turns, it uses the model you picked.`,
  bad: "Sketch: Codex answers the chat's next turns instead of Claude.",
}

export interface SusStatus {
  text: string
  tone: 'muted' | 'sus' | 'bad'
  tip: string | null
}

/** The quiet chip beside the sus switch: what the chat's next turn runs on. */
export function susStatus(
  level: SusLevel,
  modelText: string,
  pick: SusPick | null | undefined,
  models: { value: string; label: string }[],
  pinnedWord: string | null,
): SusStatus {
  if (level === 'bad') return { text: 'Routing to Codex', tone: 'bad', tip: null }
  if (pinnedWord) return { text: pinnedWord, tone: 'muted', tip: null }
  if (level === 'fine') return { text: modelText, tone: 'muted', tip: null }
  if (!pick) {
    return {
      text: 'Sus · learning',
      tone: 'sus',
      tip: `Uses the normal model until a setting has ${SUS_LEARNING_TURNS} counted turns.`,
    }
  }
  return {
    text: `${modelTriggerLabel(pick.model, models)} · ${Math.round(pick.pushbackRate * 100)}% pushback`,
    tone: 'sus',
    tip: `Runs on the setting that pushes back least, over ${pick.turns} counted turns.`,
  }
}

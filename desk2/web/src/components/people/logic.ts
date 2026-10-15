// What "Your people" sends: the form's fields turned into the request shared/people.ts defines.
import type { PeopleSaveRequest, StarterManager } from '@shared/people'

export interface PeopleForm {
  authorityName: string
  authorityHow: string
  authorityRulings: string
  /** Starter slugs the user kept. */
  picked: string[]
  /** Managers the user typed in. */
  added: { name: string; title: string }[]
}

/** The authority's brief: how they decide, then their rulings (optional) under a heading. */
export function authorityBrief(how: string, rulings: string): string {
  const h = how.trim()
  const r = rulings.trim()
  return [h, r ? `## Rulings\n\n${r}` : ''].filter(Boolean).join('\n\n')
}

export function buildRequest(form: PeopleForm, starters: readonly StarterManager[]): PeopleSaveRequest {
  const name = form.authorityName.trim()
  return {
    authority: name ? { name, brief: authorityBrief(form.authorityHow, form.authorityRulings) } : null,
    managers: [
      ...starters.filter((s) => form.picked.includes(s.slug)),
      ...form.added
        .filter((m) => m.name.trim())
        .map((m) => ({ name: m.name.trim(), title: m.title.trim(), brief: `${m.name.trim()} is a manager${m.title.trim() ? `: ${m.title.trim()}` : ''}.` })),
    ],
  }
}

/** Nothing to write: the page's save button stays off. */
export const isBlank = (req: PeopleSaveRequest): boolean => !req.authority && req.managers.length === 0

/** The initials on a person's chip. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '')).toUpperCase()
}

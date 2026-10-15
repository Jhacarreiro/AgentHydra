// "Your people": the first-run setup that writes the people folders docs/PEOPLE.md defines
// (~/.agenthydra/people/<family>/<slug>/persona.json + brief.md) and runs the Hydra Core catalog build.
// This file is what the server answers and the page reads; the server side is server/src/people/.

export const PEOPLE_STATE = '/api/people/state'
export const PEOPLE_SAVE = '/api/people/save'

/** A person to write: the same shape for the highest authority and for a manager. */
export interface PersonDraft {
  name: string
  /** A few lines on how they decide (the brief). */
  brief: string
  /** One plain line: when to pick them. */
  oneLiner?: string
  /** Job title. Managers only. */
  title?: string
}

/** An invented starter manager the page offers; the user can edit it before saving. */
export interface StarterManager extends PersonDraft {
  slug: string
  title: string
  oneLiner: string
}

export interface PeopleState {
  /** True when no manager and no highest authority exist yet: the page offers itself on first run. */
  empty: boolean
  /** Where the folders live, as the user sees them. */
  folder: string
  authority: string | null
  managers: string[]
  starters: StarterManager[]
}

export interface PeopleSaveRequest {
  authority?: PersonDraft | null
  /** Starters to keep (edited) and managers the user added. */
  managers: (PersonDraft & { slug?: string })[]
}

export interface PeopleSaveResponse {
  written: string[]
  /** The catalog build's last line, or why it failed; the files are written either way. */
  catalog: { ok: boolean; message: string }
  state: PeopleState
}

/** The only characters a folder name carries; the same rule as a manager slug. */
export const PERSON_SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

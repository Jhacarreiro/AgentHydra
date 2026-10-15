// The people store: one interface, two homes ("This PC" and "CrAInium"). docs/PEOPLE.md is the format.
// A person is one record: its persona.json, its optional brief, its learnings and its playbook and avatar files.
// This PC keeps the working copy (the folders the Hydra Core catalog reads); CrAInium is a private synced second home.

export const FAMILIES = ['manager', 'board', 'expert', 'dredd-seat', 'creator'] as const
export type Family = (typeof FAMILIES)[number]

/** A thing a person learned, kept as plain text. */
export interface Learning {
  id: string
  text: string
  at: string
}

/** A person-folder file besides the three above: `playbook/<name>.md` as text, `avatar.jpg|png|webp` as base64. */
export interface PersonFile {
  path: string
  text?: string
  base64?: string
}

export interface PersonRecord {
  /** `<family>/<slug>` */
  id: string
  family: Family
  slug: string
  /** The persona.json content. */
  persona: Record<string, unknown>
  /** The brief file's text, when the person has one. */
  brief: string | null
  learnings: Learning[]
  /** ISO time of the last change: newer wins in a sync. */
  updatedAt: string
  /** The playbook and avatar files, when the person has any. */
  files?: PersonFile[]
}

export interface PersonSummary {
  id: string
  family: Family
  slug: string
  name: string
  updatedAt: string
}

export type HomeKind = 'pc' | 'crainium'

export interface PeopleHome {
  kind: HomeKind
  list(): Promise<PersonSummary[]>
  get(id: string): Promise<PersonRecord | null>
  /** Write the record as given (its updatedAt is kept, so a pulled copy does not look newer than its source). */
  put(record: PersonRecord): Promise<void>
  delete(id: string): Promise<void>
}

export function personId(family: string, slug: string): string {
  return `${family}/${slug}`
}

/** Splits and checks an id; null when it is not a safe `<family>/<slug>`. */
export function parseId(id: string): { family: Family; slug: string } | null {
  const [family, slug, ...rest] = id.split('/')
  if (rest.length || !family || !slug) return null
  if (!(FAMILIES as readonly string[]).includes(family)) return null
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return null
  return { family: family as Family, slug }
}

export function summaryOf(r: PersonRecord): PersonSummary {
  const name = typeof r.persona.name === 'string' && r.persona.name ? r.persona.name : r.slug
  return { id: r.id, family: r.family, slug: r.slug, name, updatedAt: r.updatedAt }
}

/** A thing the CrAInium home cannot do right now, in words for the Settings page. */
export class HomeUnavailable extends Error {}

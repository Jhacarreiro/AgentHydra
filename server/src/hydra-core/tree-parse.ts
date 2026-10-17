import type { Step } from './tree'

export interface Parsed {
  kw: string
  text?: string
  n?: number
  picks?: string[]
  label?: string
  roles?: { label: string; need: string }[]
}

const TOKEN = /^(\d+|(?:person|instrument|worker|knowledge|skill):[a-z0-9-]+)$/

export const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

function pickAnswer(t: string): Parsed | null {
  if (/^none\b/i.test(t))
    return { kw: 'none', text: t.replace(/^none\b\s*:?\s*/i, '') || undefined }
  if (/^more\b/i.test(t)) return { kw: 'more', label: t.replace(/^more\b\s*/i, '') || undefined }
  const toks = t.split(/[\s,]+/).filter(Boolean)
  return toks.length && toks.every((x) => TOKEN.test(x)) ? { kw: 'picks', picks: toks } : null
}

function parseRole(line: string): { label: string; need: string } {
  const m = line.match(/^[-*]?\s*([^:]{1,60}):\s*(.+)$/)
  return m ? { label: m[1].trim(), need: m[2].trim() } : { label: line.slice(0, 60), need: line }
}

function parseQ1(t: string, first: boolean): Parsed | null {
  if (first) {
    const no = t.match(/^no\b(?:\s+([1-5])\b)?/i)
    if (no) return { kw: 'no', n: Number(no[1] ?? 1) }
    const yes = t.match(/^yes\b\s*(?:([1-5])\b)?\s*:?\s*(.+)$/i)
    return yes ? { kw: 'yes', n: yes[1] ? Number(yes[1]) : undefined, text: yes[2].trim() } : null
  }
  if (/^no\b/i.test(t)) return { kw: 'no' }
  const y = t.match(/^yes\b\s*:?\s*(.+)$/i)
  return y ? { kw: 'yes', text: y[1].trim() } : null
}

function parseQ2(t: string): Parsed | null {
  return /^mid\b/i.test(t) ? { kw: 'mid' } : /^new\b/i.test(t) ? { kw: 'new' } : null
}

function parseQ3(t: string): Parsed | null {
  return /^myself\b/i.test(t)
    ? { kw: 'myself' }
    : /^delegate\b/i.test(t)
      ? { kw: 'delegate' }
      : null
}

function parseQ4(t: string): Parsed | null {
  const m = t.match(/^([1-5])\b/)
  return m ? { kw: 'tier', n: Number(m[1]) } : null
}

function parseQ5(t: string): Parsed | null {
  const m = t.match(/^(\d{1,3})\b/)
  return m && Number(m[1]) >= 1 ? { kw: 'team', n: Number(m[1]) } : null
}

function parseQ6(t: string): Parsed | null {
  return t ? { kw: 'lead', text: t } : null
}

function parseQ7(t: string, raw: string): Parsed | null {
  if (/^none\b/i.test(t)) return { kw: 'none', roles: [] }
  const roles = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseRole)
  return roles.length ? { kw: 'roles', roles } : null
}

function parseQ8(t: string): Parsed | null {
  return /^none\b/i.test(t) ? { kw: 'none' } : t ? { kw: 'need', text: t } : null
}

function parseQ9(_t: string, raw: string): Parsed | null {
  return raw.trim() ? { kw: 'plan', text: raw.trim() } : null
}

const READERS: Partial<Record<Step, (t: string, raw: string) => Parsed | null>> = {
  q2: parseQ2,
  q3: parseQ3,
  q4: parseQ4,
  q5: parseQ5,
  q6: parseQ6,
  q6pick: pickAnswer,
  q7pick: pickAnswer,
  q8pick: pickAnswer,
  q7: parseQ7,
  q8: parseQ8,
  q9: parseQ9,
}

export function parse(step: Step, raw: string, first = false): Parsed | null {
  const t = squash(raw)
  if (step === 'q1') return parseQ1(t, first)
  const read = READERS[step]
  return read ? read(t, raw) : null
}

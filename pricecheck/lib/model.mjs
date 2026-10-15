// pricecheck/lib/model.mjs - the price list: what each thing a person sees on a page costs them, and the rollup
// that turns attributed counts into a page's price and each file's share of it.
//
// Every measurer (static: reads the code; live: reads the rendered page) emits Items, and only Items:
//   { unit, count, file, line?, note? }   file = the source file that put it on the page ('(page)' when no file can be named)
// rollup() is the one place points are computed, so a static price and a live price use the same arithmetic.

/** Each unit: its weight in points and how many come free per page (a page with 4 type sizes pays for none of them). */
export const UNITS = {
  word: { weight: 1, free: 0, what: 'a word the person reads' },
  control: { weight: 2, free: 0, what: 'a button, link, tab or toggle: one more thing to decide whether to press' },
  choice: { weight: 1, free: 0, what: 'an option inside a menu, select or radio group, past the first' },
  field: { weight: 3, free: 0, what: 'a form field the person has to fill in' },
  feature: { weight: 3, free: 0, what: 'a section, card or tile the eye has to take in' },
  media: { weight: 1, free: 0, what: 'an image, icon or illustration' },
  product: { weight: 3, free: 0, what: 'a push toward another product' },
  interruption: { weight: 15, free: 0, what: 'a dialog, banner, toast or cookie bar showing when the page opens' },
  motion: { weight: 5, free: 0, what: 'something moving on its own' },
  screen: { weight: 10, free: 1, what: 'a screen of scrolling (the first is free)' },
  color: { weight: 1, free: 6, what: 'a distinct text or fill color (the first 6 are free)' },
  type: { weight: 2, free: 4, what: 'a distinct font size (the first 4 are free)' },
  wait: { weight: 1, free: 10, what: 'each 100 ms before the page is usable (the first second is free)' },
}

export const UNIT_NAMES = Object.keys(UNITS)

/** The units with a repo's `weights` overrides ({ unit: number } or { unit: { weight, free } }) applied. Unknown units are refused. */
export function priceList(overrides = {}) {
  const list = {}
  for (const [name, u] of Object.entries(UNITS)) list[name] = { weight: u.weight, free: u.free }
  for (const [name, v] of Object.entries(overrides ?? {})) {
    if (!list[name]) throw new Error(`pricecheck: unknown unit "${name}" in weights (known: ${UNIT_NAMES.join(', ')})`)
    if (typeof v === 'number') list[name].weight = v
    else Object.assign(list[name], v)
  }
  return list
}

const add = (bag, unit, n) => {
  bag[unit] = (bag[unit] ?? 0) + n
}

/**
 * Items -> { points, units, byFile }. A unit's free allowance comes off the page total once; a file's share is its
 * weighted count, scaled down in proportion when an allowance applies, so byFile always sums to points.
 */
export function rollup(items, list = priceList()) {
  const units = {}
  const fileUnits = {}
  for (const it of items) {
    if (!list[it.unit]) throw new Error(`pricecheck: unknown unit "${it.unit}" from ${it.file}`)
    if (!(it.count > 0)) continue
    add(units, it.unit, it.count)
    const f = (fileUnits[it.file] ??= {})
    add(f, it.unit, it.count)
  }
  const paid = {}
  let points = 0
  for (const [unit, n] of Object.entries(units)) {
    const { weight, free } = list[unit]
    paid[unit] = Math.max(0, n - free)
    points += paid[unit] * weight
  }
  const byFile = {}
  for (const [file, fu] of Object.entries(fileUnits)) {
    let p = 0
    for (const [unit, n] of Object.entries(fu)) p += units[unit] ? (n / units[unit]) * paid[unit] * list[unit].weight : 0
    byFile[file] = { points: round(p), units: fu }
  }
  return { points: round(points), units, byFile }
}

const round = (n) => Math.round(n * 10) / 10

/** The files that cost the most on a page, most first: [{ file, points, units }]. */
export function topFiles(page, n = 5) {
  return Object.entries(page.byFile ?? {})
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.points - a.points)
    .slice(0, n)
}

/** One line a person can read: "48 points: 22 words, 6 controls x2, 2 fields x3 ...". */
export function describe(page, list = priceList()) {
  const parts = Object.entries(page.units ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => UNIT_NAMES.indexOf(a) - UNIT_NAMES.indexOf(b))
    .map(([unit, n]) => {
      const { weight, free } = list[unit]
      const plural = n === 1 ? unit : `${unit}s`
      return `${n} ${plural}${weight === 1 ? '' : ` x${weight}`}${free ? ` (${free} free)` : ''}`
    })
  return `${page.points} points: ${parts.join(', ')}`
}

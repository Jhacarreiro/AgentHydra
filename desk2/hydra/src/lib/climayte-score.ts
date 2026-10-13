// The one CliMayte score on the page: pass counts 1, a small fix (slip) 2/3, a rework 1/3, a failure 0,
// over everything scored. Pooled from counts, never by averaging rows' scores. Mirrors scoreOf in
// server/src/climayte-scorecard.ts, which is also what routing uses.
export interface ScoreCounts {
  pass: number
  slip: number
  rework: number
  failed: number
}

export function climayteScore(c: ScoreCounts): number | null {
  const n = c.pass + c.slip + c.rework + c.failed
  return n ? (c.pass + (c.slip * 2) / 3 + c.rework / 3) / n : null
}

/** "87%", but never "100%" while anything failed and never "0%" while anything passed. */
export function formatScorePct(score: number | null, anyBad: boolean, anyGood: boolean): string {
  if (score === null) return '—'
  const p = Math.round(score * 100)
  if (p >= 100 && anyBad) return '>99%'
  if (p <= 0 && anyGood) return '<1%'
  return `${p}%`
}

export const countsPct = (c: ScoreCounts): string =>
  formatScorePct(climayteScore(c), c.slip + c.rework + c.failed > 0, c.pass > 0)

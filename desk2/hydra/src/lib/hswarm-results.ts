// The arithmetic behind HSwarm's "Model results" cards: thumbs up and down per model (HSwarm's own tasks and
// CliMayte's scorecard, side by side), tokens per successful task, and the ranking that keeps a model with two
// lucky successes from topping the list. Kept apart from the card so the numbers can be read on their own.
import type { CliMayteScorecard } from '@/lib/api'

/** Fewer successes (or tasks) than this and one task moves the number too far to rank the model. */
export const SMALL_SAMPLE = 5

export type ResultsSource = 'both' | 'hswarm' | 'climayte'

export interface ThumbRow {
  key: string
  source: 'hswarm' | 'climayte'
  model: string
  up: number
  down: number
}

/** Input and output tokens of a model's tasks per successful one. Cache reads and cache writes are left out:
 *  a cache read is the same prompt sent again on every turn, so counting it would bill one task many times over.
 *  Null with no success, and null when the route recorded no tokens at all (a subscription route reports none),
 *  so the card shows a dash rather than a 0 that reads as "free". */
export function tokensPerOk(input: number, output: number, ok: number): number | null {
  const tokens = input + output
  if (ok <= 0 || tokens <= 0) return null
  return Math.round(tokens / ok)
}

/** Models with fewer than SMALL_SAMPLE of the counted thing go after every other model, fewest-first within each group. */
export function rankBySample<T extends { small: boolean; value: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Number(a.small) - Number(b.small) || a.value - b.value)
}

/** HSwarm's own thumbs (ok and failed) and CliMayte's (pass and fail), one row per model per source, busiest first.
 *  CliMayte's scorecard splits a model by kind and thinking level; its thumbs are summed per model here. */
export function thumbRows(
  hswarm: Array<{ model: string; ok: number; failed: number }>,
  climayte: CliMayteScorecard['rows'] | null,
  source: ResultsSource,
): ThumbRow[] {
  const rows: ThumbRow[] = []
  if (source !== 'climayte') {
    for (const m of hswarm) {
      rows.push({ key: `hswarm:${m.model}`, source: 'hswarm', model: m.model, up: m.ok, down: m.failed })
    }
  }
  if (source !== 'hswarm' && climayte) {
    const byModel = new Map<string, { up: number; down: number }>()
    for (const r of climayte) {
      const model = r.model ?? 'unknown'
      const sum = byModel.get(model) ?? { up: 0, down: 0 }
      sum.up += r.pass
      sum.down += r.fail
      byModel.set(model, sum)
    }
    for (const [model, sum] of byModel) {
      rows.push({ key: `climayte:${model}`, source: 'climayte', model, ...sum })
    }
  }
  return rows.sort((a, b) => b.up + b.down - (a.up + a.down) || a.model.localeCompare(b.model))
}

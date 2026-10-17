// The Free accounts' numbers on the Usage history card (owner, 2026-10-08: "total tokens ... for Claude and ChatGPT ...
// and also per each ... also the success rate across which models ... were used on each"). Everything comes from Desk's
// daily record (stats.ts) over the card's period: the totals' tokens are its days' tokens, the number the card's header
// adds up. They followed the table's Tokens window (5 hours, week, all time) until 2026-10-17, so the tiles read "this
// week" whatever period was picked and disagreed with the header (owner: "the top says 262 million tokens and the all
// free tokens shows 149"). Each account's own tokens are the table's Tokens column, so the card has no list of accounts
// (owner, 2026-10-08: "don't need this").
import type { FreeInstance, FreeProvider, FreeStatRow } from '@desk/shared/free-instances'

/** Messages sent and failed, the failures by their error code (`why`); `tokens` as the row says where it came from. */
export interface FreeTally { sent: number; failed: number; tokens: number; why: Record<string, number> }
export interface FreeModelTally extends FreeTally { model: string; provider: FreeProvider }
export interface FreeSummary {
  /** Messages and tokens over the record's days (tokens: the sum of `days`). */
  totals: Record<'all' | FreeProvider, FreeTally>
  /** Every model any account was sent to over the record's days, most messages first; tokens over those days. */
  models: FreeModelTally[]
  /** Each of the record's days, oldest first, with each provider's tokens (no-message days at 0). */
  days: Array<{ key: string; claude: number; chatgpt: number }>
}

/** The share of messages answered, or null when none were sent. */
export const answeredShare = (t: Pick<FreeTally, 'sent' | 'failed'>): number | null => (t.sent ? (t.sent - t.failed) / t.sent : null)

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const byMessages = (a: FreeModelTally, b: FreeModelTally) => b.sent - a.sent || b.tokens - a.tokens || a.model.localeCompare(b.model)

export function summarizeFree(rows: readonly FreeStatRow[], instances: readonly FreeInstance[], days: number, now: number): FreeSummary {
  const blank = (): FreeTally => ({ sent: 0, failed: 0, tokens: 0, why: {} })
  const addWhy = (t: FreeTally, why: Record<string, number> | undefined) => { for (const [code, n] of Object.entries(why ?? {})) t.why[code] = (t.why[code] ?? 0) + n }
  const totals = { all: blank(), claude: blank(), chatgpt: blank() }
  const byId = new Map(instances.map(i => [i.id, i]))
  const models = new Map<string, FreeModelTally>()
  const keys = Array.from({ length: days }, (_, k) => dayKey(now - (days - 1 - k) * 86_400_000))
  const perDay = new Map(keys.map(key => [key, { key, claude: 0, chatgpt: 0 }]))
  for (const r of rows) {
    const instance = byId.get(r.instanceId)
    if (!instance) continue
    const day = perDay.get(r.day)
    if (day) {
      const n = r.input + r.output
      day[instance.provider] += n
      totals.all.tokens += n; totals[instance.provider].tokens += n
    }
    for (const t of [totals.all, totals[instance.provider]]) { t.sent += r.sent; t.failed += r.failed; addWhy(t, r.why) }
    // No model (stats.ts UNRECORDED_MODEL) counts by day and in the totals only. Days recorded before 2026-10-11 hold
    // the same sends, ones that failed before a model was picked, as 'unknown'.
    if (!r.model || r.model === 'unknown') continue
    const key = `${instance.provider}/${r.model}`
    const m = models.get(key) ?? { model: r.model, provider: instance.provider, ...blank() }
    m.sent += r.sent; m.failed += r.failed; m.tokens += r.input + r.output
    addWhy(m, r.why)
    models.set(key, m)
  }
  return {
    totals,
    models: [...models.values()].sort(byMessages),
    days: [...perDay.values()],
  }
}

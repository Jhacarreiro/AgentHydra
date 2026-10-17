// `bun scripts/tool-intent-bench.ts` - how well hydra_find finds the right tool, by words alone and by words and
// meaning fused (mcp-find.ts fuseRanks), over asks put the way an agent says them rather than in the tool's own words.
// Runs the real local model (tool-intent.ts), so the first run downloads it. Prints top-1 and top-3 for words, and for
// each way of scoring a tool's head and whole text (COMBINE) its meaning alone and each fusion setting tried; COMBINE
// in tool-intent.ts and FUSE in mcp-find.ts hold the pair this picked.
//
//   --misses   also list every ask the picked setting misses at top-3
import { join } from 'node:path'
import { DATA_DIR } from '../server/src/config'
import { TOOLS } from '../server/src/mcp'
import { type FoundTool, FUSE, fuseRanks, rankTools } from '../server/src/mcp-find'
import {
  COMBINE,
  type Combine,
  type IntentHit,
  loadLocalEmbedder,
  ToolIntent,
} from '../server/src/tool-intent'

/** Invented asks, each with the tools that would answer it (any one counts). */
const ASKS: [string, string[]][] = [
  ['is this signup screen too cluttered for a new visitor', ['price_tag']],
  ['this settings form has way too much on it', ['price_tag']],
  ['I am about to redesign the pricing page, measure how busy it is first', ['price_tag']],
  ['how heavy is the settings page for someone reading it', ['price_tag', 'price_tag_live']],
  ['which page should I simplify first', ['price_tag_next']],
  ['how much attention does the deployed homepage ask of people', ['price_tag_live']],
  [
    'how much of my allowance is left before I hit the wall',
    ['check_my_usage', 'usage_budget', 'check_usage'],
  ],
  ['which login still has headroom for a big job', ['list_usage']],
  ['bounce the background service so it picks up my edits', ['daemon_restart']],
  ['give this conversation a better name', ['desk_chat', 'chat_rename']],
  ['point this chat at a different repo', ['desk_chat', 'move_chat_folder']],
  ['hand a self-contained job to an idle subscription', ['climayte_run', 'climayte_manage']],
  ['open several visible chats on other logins to work in parallel', ['fan_out']],
  ['what did that conversation cost in dollars', ['get_spend', 'get_run_cost']],
  ['find where the word deadline came up in old chats', ['search_sessions', 'history_search']],
  ['I lost a file path after my context was summarized', ['history_search', 'history_read']],
  ['which files were touched lately across sessions', ['get_recent_edits']],
  ['chats that got cut off by the weekly cap', ['list_rate_limited_sessions', 'babysitter']],
  ['spin up the vite server for this project', ['dev_servers']],
  ['hide an old chat from the sidebar', ['archive_desktop_chat']],
  ['transfer one chat to a different subscription', ['move_chat']],
  ['did any passwords or keys leak into a transcript', ['scan_session_secrets']],
  ['which agents are busy right now and which wait for me', ['agent_status']],
  ['tell the human I am stuck and need them', ['ask_owner_help']],
  ['publish a little status website for the owner', ['dashboard_write']],
  ['simulate people browsing our site', ['sue']],
  ['which review instruments should judge this change', ['dredd']],
  ['is a newer release of this app out', ['check_update']],
  ['what is making this computer slow', ['box_doctor']],
  ['approve the permission dialog a chat is frozen on', ['unblock_prompts']],
  ['stop a worker that is going in circles', ['climayte_cancel']],
  ['why were my sessions so pricey', ['get_token_sinks']],
  // in the tools' own words: fusion must not lose what words already find
  ['restart the daemon', ['daemon_restart']],
  ['move this chat to another workspace', ['desk_chat', 'move_chat_folder']],
  ['dashboard', ['dashboard_write', 'dashboard_read']],
]

const pool = TOOLS.filter((t) => t.name !== 'hydra_run' && t.name !== 'hydra_find')
const dir = join(DATA_DIR, 'tool-intent')
const warmStarted = Date.now()
const why = await new ToolIntent(loadLocalEmbedder, { dir }).warm(pool)
if (why) throw new Error(`no intent model: ${why}`)
console.log(`model ready, ${pool.length} tools embedded in ${Date.now() - warmStarted} ms`)

type Row = { ask: string; want: string[]; words: FoundTool[]; hits: IntentHit[]; ms: number }
const runs = new Map<Combine, Row[]>()
for (const combine of ['head', 'max', 'sum'] as Combine[]) {
  const intent = new ToolIntent(loadLocalEmbedder, { dir, waitMs: 600_000, combine })
  const rows: Row[] = []
  for (const [ask, want] of ASKS) {
    const t0 = performance.now()
    const meant = await intent.search(pool, ask)
    const ms = performance.now() - t0
    if (!('hits' in meant)) throw new Error(meant.reason)
    rows.push({ ask, want, words: rankTools(pool, ask, pool.length), hits: meant.hits, ms })
  }
  runs.set(combine, rows)
}

const score = (rows: Row[], ranked: (r: Row) => string[]) => {
  let top1 = 0
  let top3 = 0
  for (const r of rows) {
    const names = ranked(r)
    if (r.want.includes(names[0])) top1++
    if (names.slice(0, 3).some((n) => r.want.includes(n))) top3++
  }
  return `top-1 ${top1}/${rows.length}  top-3 ${top3}/${rows.length}`
}

const picked = runs.get(COMBINE) ?? []
console.log(
  `asks: ${picked.length}; search took ${Math.round(picked.reduce((s, r) => s + r.ms, 0) / picked.length)} ms each on average`,
)
console.log(`words only                       ${score(picked, (r) => r.words.map((f) => f.name))}`)
for (const [combine, rows] of runs) {
  console.log(
    `\n${combine}: meaning only           ${score(rows, (r) => r.hits.map((h) => h.name))}`,
  )
  for (const k of [10, 30])
    for (const intentTop of [12, 20])
      for (const words of [0.5, 1])
        for (const w of [1, 1.5, 2]) {
          const fuse = { k, intentTop, words, intent: w }
          const mark =
            combine === COMBINE &&
            k === FUSE.k &&
            intentTop === FUSE.intentTop &&
            words === FUSE.words &&
            w === FUSE.intent
              ? ' <- picked'
              : ''
          console.log(
            `  k ${String(k).padEnd(3)} top ${String(intentTop).padEnd(3)} words x${String(words).padEnd(4)} meaning x${String(w).padEnd(4)} ${score(
              rows,
              (r) => fuseRanks(pool, r.words, r.hits, 3, undefined, fuse).map((f) => f.name),
            )}${mark}`,
          )
        }
}

if (process.argv.includes('--misses'))
  for (const r of picked) {
    const got = fuseRanks(pool, r.words, r.hits, 3).map((f) => f.name)
    if (!got.some((n) => r.want.includes(n)))
      console.log(`MISS "${r.ask}" want ${r.want.join('|')} got ${got.join(', ')}`)
  }

#!/usr/bin/env node
import { targetRoot } from "../lib/target.mjs";
// dredd/recall-parity.mjs - does the prompt hook's recall (the running MCP's memory_search) answer inside the hook's
// budget? Row 17 of MEMORY_CLOUD_CUTOVER.md proved it against the old recall over the memory files; row 18 retired
// that side.
//
//   node dredd/recall-parity.mjs [--n 10] [--top 5]
//
// Ten recorded asks from eval/asks.json that Dredd's hook fires on (dreddHookWants). Per ask, hookRecall(ask,
// memory_search via one MCP) - what dredd_hook runs in-process - prints its top list and its milliseconds, then one
// end-to-end dredd_hook call (what Claude Code gets).
// The MCP is opened ONCE before timing starts: in a chat it is already running, so its spawn is not the hook's cost.
// Reads only; memory_search records a read on each hit, exactly as the hook does. Exit 1 when a recall misses the
// budget or fails.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dreddHookWants } from "./lib/hook-recall.mjs";
import { openLocalMcp } from "./lib/mcp.mjs";
import { hookRecall } from "./lib/recall.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = targetRoot();
const BUDGET_MS = 3_500; // DREDD_HOOK_BUDGET_MS in 26c-tools-dredd.mjs; the hook's own timeout is 5 s

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) || dflt : dflt;
};
const N = flag("n", 10);
const TOP = flag("top", 5);

const asks = JSON.parse(readFileSync(path.join(HERE, "eval", "asks.json"), "utf8"))
  .asks.map((a) => a.ask)
  .filter(dreddHookWants)
  .slice(0, N);

const list = (rows) =>
  rows
    .slice(0, TOP)
    .map((r) => `${r.score != null ? `${r.score}` : "?"} ${r.slug}`)
    .join(", ") || "(none)";

const mcp = await openLocalMcp({ root: ROOT, timeoutMs: 25_000 });
let failed = 0;
try {
  const search = async (query, limit) => mcp.call("memory_search", { query, limit }, BUDGET_MS);
  for (const [i, ask] of asks.entries()) {
    const fresh = await hookRecall(ask, search, { budgetMs: BUDGET_MS });
    const inBudget = fresh.ok && fresh.ms <= BUDGET_MS;
    if (!inBudget) failed += 1;
    console.log(`\n#${i + 1} ${ask.length > 100 ? `${ask.slice(0, 97)}...` : ask}`);
    console.log(
      `  mcp lane  ${String(fresh.ms).padStart(5)} ms  ${fresh.ok ? list(fresh.rows) : `FAILED: ${fresh.error}`}  [${fresh.facets} facet(s)]`,
    );
    console.log(`  ${inBudget ? `inside the ${BUDGET_MS} ms budget` : `OUTSIDE the budget or failed`}`);
  }

  // What Claude Code itself gets from the hook entry, through the tool (needs an impl.mjs built with dredd_hook).
  const e2eAsk = asks[0];
  if (e2eAsk) {
    const t0 = Date.now();
    const e2e = await mcp.call("dredd_hook", { prompt: e2eAsk }, 5_000);
    const ms = Date.now() - t0;
    console.log(`\nEND TO END: dredd_hook { prompt: #1 } in ${ms} ms (hook timeout 5000 ms)`);
    // This client reaches the tool through connections_execute, which may add its own lines; Claude Code's mcp_tool hook
    // calls dredd_hook by name and gets the bare text. The hook's JSON is one line either way.
    let ctx = null;
    try {
      const line = String(e2e.text)
        .split(/\r?\n/)
        .find((l) => l.startsWith('{"hookSpecificOutput"'));
      ctx = line ? (JSON.parse(line).hookSpecificOutput?.additionalContext ?? null) : null;
    } catch {
      // not the hook's JSON: printed raw below
    }
    console.log(ctx ?? `  not a hook answer (${e2e.ok ? "ok" : "error"}): ${String(e2e.text).slice(0, 300)}`);
    if (!ctx || ms > 5_000) failed += 1;
  }
} finally {
  await mcp.close();
}

console.log(`\n${asks.length} asks · ${failed ? `${failed} FAILED or over budget` : "every recall inside the budget"}`);
process.exit(failed ? 1 : 0);

// dredd/lib/hook-recall.mjs - the memories a prompt needs, recalled by the MCP the chat is already running.
//
// Dredd's prompt hook (.claude/hooks/dredd-docket.mjs) spawns dredd.mjs and has ~7.5 s; spawning the local MCP for the
// memory lane costs five, so the hook used to recall by spawning a full-text search over the memory FILES instead. The
// files went (MEMORY_CLOUD_CUTOVER.md S3, rows 17-18), so recall moved INTO the running MCP: a second UserPromptSubmit
// hook, `{ type: "mcp_tool", tool: "dredd_hook" }`, calls this module in-process (26c-tools-dredd.mjs) with the MCP's
// own memory_search, and prints a `<dredd-memories>` block beside the docket. Nothing spawns, nothing reads a file.
//
// Both hooks fire on the same prompts: dreddHookWants is the one gate, and the command hook imports it too.
import { importTargetFile } from "../../lib/target.mjs";
import { pathToFileURL } from "node:url";
const { isMachinePrompt } = await importTargetFile("machinePromptHook", { isMachinePrompt: () => false });
import { memoryLines, promptWantsDredd } from "./docket.mjs";
import { hookRecall } from "./recall.mjs";

/** Does Dredd's prompt hook fire on this prompt? The shapes promptWantsDredd names, typed by a person: not a slash
 *  command, not machine text (a task notification, another session's message), not too short or too long to judge. */
export function dreddHookWants(prompt) {
  const text = String(prompt ?? "").trim();
  if (text.length < 16 || text.length > 4000) return false;
  if (/^\//.test(text)) return false;
  if (isMachinePrompt(text)) return false;
  return promptWantsDredd(text);
}

/**
 * The `<dredd-memories>` block for one prompt, or "" when the hook does not fire on it. `search(query, limit)` is the
 * running MCP's memory_search, answering `{ ok, text }`. A recall that could not run says why; it never reads as
 * "none matched".
 */
export async function dreddHookMemories(prompt, search, { budgetMs = 3_500 } = {}) {
  if (!dreddHookWants(prompt)) return "";
  return hookMemoriesBlock(await hookRecall(String(prompt).trim(), search, { budgetMs }));
}

/** The `<dredd-memories>` block for one hookRecall result: exported so recall-bench.mjs counts the tokens of exactly
 *  what the hook prints, not a copy of its format. Pure. */
export function hookMemoriesBlock(r) {
  const source = `memory lane, pgvector cosine over ${r.facets} facet(s), ${r.ms} ms`;
  const lines = !r.ok
    ? [`MEMORIES: recall could not run (${r.error}); memory_search { query } in-session.`]
    : r.rows.length
      ? memoryLines({ memories: r.rows, memorySource: source }, 5)
      : [`MEMORIES: none matched (${source}).`];
  return `<dredd-memories>\n${lines.join("\n")}\n</dredd-memories>`;
}

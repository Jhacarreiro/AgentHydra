#!/usr/bin/env node
/**
 * dredd/hooks/dredd-docket.mjs - UserPromptSubmit hook: when the prompt is a grievance, a review or a which-tool question,
 * Dredd decides which instruments to convene BEFORE the model picks how to work, and says what the memory lane already
 * knows about it.
 *
 * Owner ask (the Chair, 2026-09-21): "Whenever I complain about the copy, I need to launch a SUE, Design Critic, Boardroom
 * discussion etc. ... sometimes the AI may not know which tool to call." The same PUSH principle as Connections'
 * instrument-match.mjs (a registry that waits to be searched is dead): the bench announces itself on the prompts where it
 * matters.
 *
 * Moved here from Connections' .claude/hooks/dredd-docket.mjs (2026-10-15, Sue and Dredd off Connections). A project wires
 * it with a thin line that finds this checkout (Connections: .claude/hooks/sue-dredd-hook.mjs), so a machine without
 * sue-dredd hears nothing. It also took over the `<dredd-memories>` block the Connections MCP's `dredd_hook` tool printed
 * from a second `mcp_tool` hook: that tool lent hook-recall.mjs the running MCP's memory_search, and this checkout's own
 * MCP server has no memory lane. So on the prompts the gate lets through, ONE local MCP (the target's loader, bound to the
 * chat's folder like the chat's own) is opened while Jev decides; it costs about five seconds, the same as the Jev share,
 * so the two run side by side inside the hook's budget. Every other prompt spawns nothing.
 *
 * Mechanics: a sub-millisecond regex gate first (dreddHookWants, lib/hook-recall.mjs: the one copy of the complaint,
 * review and which-tool shapes), then `dredd.mjs --hook -- "<prompt>"` - Jev alone (no cascade) on a 4.5 s share, no
 * recall and no MCP spawn - all inside dredd's own 7.5 s budget, under this hook's hard 9 s, printed as a <dredd-docket>
 * block. When Jev is slow the docket still prints, decided by the keywords. Jev's own verdict on the ask's class is the
 * real gate: a prompt the regex let through but Jev reads as a build or a question convenes nothing, and then the docket is
 * ONE line plus only what speaks to this ask (renderDocket's compact form). Costs about $0.0007 in Jev calls per firing.
 * Fails OPEN: any error yields no output, never a blocked prompt.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { targetRoot } from "../../lib/target.mjs";

const DREDD = fileURLToPath(new URL("../dredd.mjs", import.meta.url));
const DOCKET_MS = 9_000; // dredd's own budget is 7.5 s
const MCP_OPEN_MS = 6_500; // the local MCP opens in about five seconds
const RECALL_BY_MS = 8_500; // the memories give up here, inside the docket's 9 s

/** `node dredd.mjs --hook -- <prompt>`: its trimmed stdout, or "" on any failure or a timeout. */
function docket(prompt, session, cwd) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      // `--` ends the flags: a prompt that happens to start with a dash reaches Dredd as the ask, never as a flag. The
      // session goes with it: Dredd records the docket under it, and the lane's reflection asks this chat to rate it.
      child = spawn(process.execPath, [DREDD, "--hook", "--", prompt], {
        cwd,
        env: session ? { ...process.env, DREDD_SESSION: session } : process.env,
        windowsHide: true,
      });
    } catch {
      done("");
      return;
    }
    const timer = setTimeout(() => child.kill(), DOCKET_MS);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      done("");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out.trim() : "");
    });
  });
}

/** The `<dredd-memories>` block, recalled through one local MCP bound to `folder`; null when it should not print. */
async function memories(prompt, folder, started, { dreddHookMemories, openLocalMcp }) {
  let mcp = null;
  try {
    mcp = await openLocalMcp({ root: folder, timeoutMs: MCP_OPEN_MS, clientName: "dredd-docket" });
  } catch (err) {
    return dreddHookMemories(prompt, async () => ({ ok: false, text: `the local MCP did not open: ${String(err?.message || err).slice(0, 120)}` }), {
      budgetMs: 100,
    });
  }
  try {
    const budgetMs = Math.max(500, RECALL_BY_MS - (Date.now() - started));
    // A hook never starts a browser sign-in: memory_search on a signed-out machine answers an error, read as "could not run".
    return await dreddHookMemories(prompt, (query, limit) => mcp.call("memory_search", { query, limit }, budgetMs), { budgetMs });
  } finally {
    mcp.close().catch(() => {});
  }
}

/** Read the UserPromptSubmit payload from stdin and print the docket and the memories, or nothing. */
export async function main({ stdin = () => readFileSync(0, "utf8"), write = (text) => process.stdout.write(text) } = {}) {
  const started = Date.now();
  let input;
  try {
    input = JSON.parse(stdin());
  } catch {
    return;
  }
  // Imported here rather than at the top so a lib caught mid-edit fails OPEN like every other error.
  const { dreddHookWants, dreddHookMemories } = await import("../lib/hook-recall.mjs");
  const prompt = String(input?.prompt ?? "").trim();
  // Too short or long, a slash command, or machine text (a task notification, another AI session's message) never fires.
  if (!dreddHookWants(prompt)) return;
  const { openLocalMcp } = await import("../lib/mcp.mjs");
  const session = String(input?.session_id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const folder = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const [dock, mem] = await Promise.all([
    docket(prompt, session, targetRoot()),
    memories(prompt, folder, started, { dreddHookMemories, openLocalMcp }).catch(() => ""),
  ]);
  const text = [dock, mem].filter(Boolean).join("\n");
  if (text) write(`${text}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main().catch(() => {
    /* fail open */
  });
}

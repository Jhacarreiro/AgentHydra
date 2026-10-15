// mcp/dredd-tool.mjs - the `dredd` and `dredd_hook` tools: the judge, spoken to as `node dredd/dredd.mjs ...`.
//
// The same tool names and input shapes the Connections door's chats used (src-impl/26c-tools-dredd.mjs until it moved
// here). Nothing here decides anything: dredd/bench.json and dredd/lib/docket.mjs do, so the MCP and the CLI cannot
// disagree about what Dredd would convene.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, engineDir, fmt, runProc, toolFailure } from "./proc.mjs";

export const DREDD_ACTIONS = ["docket", "plan", "convene", "hearing", "resolve", "status", "stop", "dockets", "collect", "boardroom", "bench", "doctor", "unrated"];

export const resolveDreddEngine = ({ env = process.env } = {}) => engineDir("dredd", "dredd.mjs", { env });

/**
 * The Dredd dockets a chat received and has not rated. dredd/lib/lane-record.mjs writes <lane>/dredd/<session>.json for
 * every docket it records under a session; each entry's docket.json says whether `dredd.mjs --rate` has run on it.
 * Newest first. No network.
 */
export function laneDreddDockets(dir, sid) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path.join(dir, "dredd", `${sid}.json`), "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const entry of ledger?.dockets || []) {
    let d;
    try {
      d = JSON.parse(readFileSync(path.join(entry.dir, "docket.json"), "utf8"));
    } catch {
      continue;
    }
    if (!d || d.rating) continue;
    out.push({
      id: d.id || entry.id,
      class: d.class,
      domain: d.domain,
      mode: d.mode || "docket",
      convened: (d.convene || []).map((c) => c.id),
      ask: String(d.ask || "").replace(/\s+/g, " ").trim().slice(0, 110),
      engine: d.engine ? path.join(d.engine, "dredd.mjs") : "",
      // The folder, not the id: `--rate <id>` looks only under the engine's own checkout, and a docket filed with
      // --root <another repo> or --out lives elsewhere.
      dir: entry.dir,
    });
  }
  return out.reverse();
}

/** The ask for those dockets' ratings: one `dredd.mjs --rate <folder>` line each, the six newest shown. */
export function laneDocketsItem(dockets, item) {
  if (!dockets?.length) return "";
  const SHOW = 6;
  const engine = dockets.find((d) => d.engine)?.engine || path.join(ROOT, "dredd", "dredd.mjs");
  const rows = dockets
    .slice(0, SHOW)
    .map((d) => `  ${d.id} [${d.class} · ${d.domain}, ${d.mode}] convened: ${d.convened.join(", ") || "nothing"}\n    ask: "${d.ask}"\n    folder: ${d.dir || d.id}`);
  return (
    `${item}. RATE DREDD'S DOCKETS THIS CHAT GOT (${dockets.length} unrated${dockets.length > SHOW ? `, the ${SHOW} newest shown` : ""}). ` +
    "Rate each from what the work showed; one whose work is still going, skip for now. " +
    "A docket a sub-agent of this chat filed is listed too: rate it from what that agent reported. " +
    "--score is the docket as a whole: 5 = it convened exactly the right instruments, 3 = a mix of right and wrong, 1 = the wrong tools altogether. " +
    "Every convened instrument gets one choice: right (the correct call), unneeded (it fit but added nothing), wrong (it did not fit the ask), not-run (you skipped it). " +
    "--missed names bench instruments it should have convened, --missing-tool what no instrument does, --class / --domain what the ask really was when it misread it. " +
    "A --note is required at 3 or lower and on anything wrong, unneeded or missed; --gold (the ask in your own words, never copied) whenever something was wrong, missed or misread. One shell line per docket, several in one message:\n" +
    rows.join("\n") +
    `\n   node "${engine}" --rate <folder> --score <1-5> --right <ids> --unneeded <ids> --wrong <ids> --not-run <ids> [--missed <ids>] [--missing-tool "<what>"] --note "<why>" [--gold "<the ask, reworded>"]\n`
  );
}

/** The engine's answer to one action. `run` is the seam a spec stubs the engine with. */
export async function runDredd(
  { action, ask, url, root: rootArg, docket, announce, rounds, seats, fromLine, limit, session },
  { engine = resolveDreddEngine(), run = runProc, env = process.env } = {},
) {
  if (!engine) {
    return toolFailure(
      "dredd_engine_missing",
      "[dredd] the Dredd engine is not on this machine, so there is no judge to ask.",
      "It lives in this sue-dredd checkout's dredd/ folder (DREDD_ENGINE_DIR names another). Nothing was run.",
    );
  }
  if (!DREDD_ACTIONS.includes(action)) {
    return toolFailure("dredd_unknown_action", `[dredd] unknown action "${action}".`, `Use one of: ${DREDD_ACTIONS.join(", ")}.`);
  }
  if (action === "bench") {
    const bench = JSON.parse(readFileSync(path.join(engine, "bench.json"), "utf8"));
    const lines = bench.instruments.map((i) => `- ${i.id} [${i.mode}, phase ${i.phase}] - ${i.judges.split(". ")[0]}. When: ${i.when} Run: ${i.run}`);
    return `DREDD'S BENCH - ${bench.instruments.length} instruments (dredd/bench.json)\n\n${lines.join("\n")}\n\nAsk Dredd: dredd { action:"docket", ask }.`;
  }
  if (action === "unrated") {
    const sid = session || env.CLAUDE_CODE_SESSION_ID;
    if (!sid) return toolFailure("dredd_needs_session", "[dredd] 'unrated' needs the chat's session id.", "Pass it in `session`.");
    const lane = await import(pathToFileURL(path.join(engine, "lib", "lane-record.mjs")).href);
    const dir = lane.laneDir({ env });
    return (dir && laneDocketsItem(laneDreddDockets(dir, sid), 1)) || "No unrated dockets for this chat.";
  }
  // The engine runs where its checkout is (bench.json, the seats and the checks live there); `root` names the
  // repository judged when it is another one. Every call has a ceiling.
  const cwd = path.dirname(engine);
  const rootFlags = rootArg ? ["--root", String(rootArg)] : [];
  if (action === "doctor") {
    const result = await run(process.execPath, [path.join(engine, "dredd.mjs"), "--doctor", ...rootFlags], { cwd, timeoutMs: 120_000 });
    return String(result.stdout || "").trim() || fmt("$ dredd --doctor", result);
  }
  if (["collect", "resolve", "status", "stop"].includes(action) && !docket) {
    return toolFailure(
      "dredd_needs_docket",
      `[dredd] '${action}' needs the docket directory a previous 'convene' or 'hearing' returned.`,
      "Pass it in `docket` ('dockets' lists them).",
    );
  }
  // The reading doors: the docket on disk answers, in seconds, whatever is running.
  if (action === "status" || action === "stop" || action === "dockets") {
    const argv = [path.join(engine, "dredd.mjs"), ...rootFlags, `--${action}`];
    if (docket) argv.push("--docket", docket);
    if (action === "status" && Number.isFinite(Number(fromLine))) argv.push("--from-line", String(Math.max(0, Math.floor(Number(fromLine)))));
    if (action === "dockets" && url) argv.push("--url", url);
    if (action === "dockets" && Number.isFinite(Number(limit))) argv.push("--limit", String(Math.max(1, Math.floor(Number(limit)))));
    const result = await run(process.execPath, argv, { cwd, timeoutMs: 60_000 });
    return String(result.stdout || "").trim() || fmt(`$ dredd ${action}`, result);
  }
  if (!ask && !docket) return toolFailure("dredd_needs_ask", `[dredd] '${action}' needs an ask (or a docket directory).`, "Pass the person's words in `ask`.");
  if (action === "boardroom") {
    const argv = [path.join(engine, "boardroom.mjs"), "--quiet", ...rootFlags];
    if (docket) argv.push("--docket", docket);
    if (rounds) argv.push("--rounds", String(rounds));
    if (Array.isArray(seats) && seats.length) argv.push("--seats", seats.join(","));
    if (ask) argv.push(ask);
    const result = await run("bun", argv, { cwd, timeoutMs: 10 * 60_000 });
    const out = String(result.stdout || "").trim();
    const dir = docket ? path.join(docket, "boardroom") : null;
    const transcript = dir && existsSync(path.join(dir, "transcript.md")) ? readFileSync(path.join(dir, "transcript.md"), "utf8") : "";
    return transcript || out || fmt("$ dredd boardroom", result);
  }
  const argv = [path.join(engine, "dredd.mjs"), ...rootFlags];
  if (docket) argv.push("--docket", docket);
  if (action === "plan") argv.push("--member");
  if (action === "convene") argv.push("--convene");
  // A hearing and a resolve run detached: the call returns the docket in seconds and 'status' reads it.
  if (action === "hearing") argv.push("--hearing", "--detach");
  if (action === "resolve") argv.push("--resolve", "--detach");
  if (action === "collect") argv.push("--collect");
  if (announce) argv.push("--announce");
  if (url) argv.push("--url", url);
  if (ask) argv.push("--", ask);
  const result = await run(process.execPath, argv, {
    cwd,
    // The lane records every new docket and names its door (dredd/lib/lane-record.mjs).
    env: { DREDD_DOOR: "mcp" },
    timeoutMs: action === "hearing" || action === "resolve" ? 120_000 : action === "convene" ? 30 * 60_000 : 90_000,
  });
  const out = String(result.stdout || "").trim();
  if (action === "hearing" || action === "resolve") {
    const m = /^Docket: (.+)$/m.exec(out);
    const dir = docket || (m ? m[1].trim() : null);
    if (dir) return `${out}\n\nPoll: dredd { action: "status", docket: ${JSON.stringify(dir)} } until verdict.md is in the answer; dredd { action: "stop", docket } ends it.`;
  }
  return out || fmt(`$ dredd ${action}`, result);
}

export const dreddTool = {
  name: "dredd",
  description:
    "DREDD - the judge. Give it any ask (a complaint, a review, a decision, 'which tool do we have for this') and it returns a " +
    "DOCKET: which instruments to convene and in what order, the exact command for each, which memories bear on it and which " +
    "tier should do the work." +
    "\n\nACTIONS: 'docket' (decide only, fast) · 'plan' (a member's goal: the member settings checklist) · 'convene' (decide " +
    "AND run) · 'hearing' (the whole thing, unattended, up to an hour; returns its docket directory in seconds, poll 'status') · " +
    "'resolve' (the resolution loop again on a docket; poll 'status') · 'status' (with `docket`, from `fromLine`) · 'stop' " +
    "(with `docket`) · 'dockets' (past dockets newest first; `url` filters) · 'collect' (with `docket`: the field reports, then " +
    "the board's second sitting) · 'boardroom' (just the critics arguing) · 'bench' (the roster) · 'doctor' (can this machine " +
    "hold a hearing?) · 'unrated' (this chat's dockets not yet rated, with the --rate line each; `session` defaults to the " +
    "chat's). Pass `url` when a page is the subject, `root` to judge ANOTHER repository. Manual: dredd/README.md.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: DREDD_ACTIONS, description: DREDD_ACTIONS.join(" | ") },
      ask: { type: "string", description: "docket/plan/convene/boardroom: the ask, in the person's own words." },
      url: { type: "string", description: "the page in question, when there is one." },
      root: { type: "string", description: "the repository to judge (default: this checkout). The docket lands in <root>/tmp/dredd." },
      docket: { type: "string", description: "convene/collect/boardroom/resolve/status/stop: an existing docket directory." },
      announce: { type: "boolean", description: "convene: post the convened docket on the team board as an FYI (default false)." },
      rounds: { type: "number", description: "boardroom: rounds of argument (default 2)." },
      seats: { type: "array", items: { type: "string" }, description: "boardroom: seat ids to seat (default all six)." },
      fromLine: { type: "number", description: "status: the first hearing.log line to return." },
      limit: { type: "number", description: "dockets: how many rows (default 20)." },
      session: { type: "string", description: "unrated: the chat's session id (default: CLAUDE_CODE_SESSION_ID)." },
    },
    required: ["action"],
  },
  run: (params) => runDredd(params),
};

// ── dredd_hook: the memories for Dredd's prompt hook ──────────────────────────────────────────
// A UserPromptSubmit `mcp_tool` hook calls this with the prompt; the gate, the facets and the block's wording live in the
// engine's hook-recall.mjs. This server has no memory lane of its own, so its default search says so, and the block reads
// "recall could not run" rather than "none matched". A host with a memory search hands it in as `search`.

let hookModule = null;
const DREDD_HOOK_BUDGET_MS = 3_500; // the hook's own timeout is 5 s; the recall gives up well inside it

const noMemoryLane = async () => ({ ok: false, text: "this sue-dredd MCP server has no memory lane" });

/** The UserPromptSubmit JSON whose additionalContext is the `<dredd-memories>` block, or "" when Dredd does not judge the
 *  prompt or there is no engine. */
export async function dreddHookAnswer(params = {}, { search = noMemoryLane, engine = resolveDreddEngine() } = {}) {
  if (!engine) return "";
  if (!hookModule) {
    hookModule = import(pathToFileURL(path.join(engine, "lib", "hook-recall.mjs")).href).catch((e) => {
      hookModule = null;
      throw e;
    });
  }
  const mod = await hookModule;
  const text = await mod.dreddHookMemories(String(params.prompt ?? ""), search, { budgetMs: DREDD_HOOK_BUDGET_MS });
  return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }) : "";
}

export const dreddHookTool = {
  name: "dredd_hook",
  description:
    "Not for direct use: Claude Code's UserPromptSubmit `mcp_tool` hook calls this with the prompt. When the prompt is one " +
    "Dredd judges, it answers a <dredd-memories> block; otherwise it answers nothing.",
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string" }, session_id: { type: "string" }, cwd: { type: "string" } },
  },
  run: async (params = {}) => {
    let text = "";
    try {
      text = await dreddHookAnswer(params);
    } catch (e) {
      process.stderr.write(`dredd_hook: ${e?.message || e}\n`);
    }
    return { content: [{ type: "text", text }] };
  },
};

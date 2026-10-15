// mcp/sue-tool.mjs - the `sue` tool: real simulated people through a real page, then their verdict.
//
// The same tool name and input shape the Connections door's chats used (services/studio/local-mcp/src-impl/26b-tools-sue.mjs
// until it moved here), so a chat's calls keep working once its MCP config points at this server. The engine is this
// checkout's sue/sue.mjs, spoken to as `node sue/sue.mjs <action> --workspace <dir> --json[-file] ...`; 'move' calls the
// engine's own hand-move.mjs in-process. Nothing here decides who goes, which project or which mailbox: the engine does.
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { engineDir, fmt, runProc, toolFailure } from "./proc.mjs";

export const SUE_ACTIONS = [
  "run", "status", "report", "analytics", "stop", "personas", "presue", "save_persona", "edit_persona", "journal",
  "scoreboard", "profiles", "focus_group", "ape", "art", "room", "room_say", "watch", "inbox_test", "inbox_test_report",
  "blind_round",
];

/** The actions that start a wave, and so wait longer for the engine's answer. */
const SUE_STARTS = ["run", "focus_group", "ape", "art", "inbox_test", "blind_round"];

/** Past this many characters a run's arguments go to the engine in a file: a Windows command line holds ~32k. */
const SUE_ARGS_INLINE_MAX = 8000;

/** The engine on this machine, `{ engineDir, exe, env }`, or null. SUE_HOME rides along so 'move' finds the run's relay. */
export function resolveSueEngine({ env = process.env } = {}) {
  const dir = engineDir("sue", "sue.mjs", { env });
  return dir ? { engineDir: dir, exe: process.execPath, env: env.SUE_HOME ? { SUE_HOME: env.SUE_HOME } : {} } : null;
}

// ── sue launch env: pure helper START
/** The calling chat's identity for a Sue run, so its spec names the chat that started it. */
export function sueLaunchEnv(chat) {
  const session = chat.env?.CLAUDE_CODE_SESSION_ID;
  return {
    ...(session ? { SUE_LAUNCHED_SESSION: session } : {}),
    SUE_LAUNCHED_VIA: "mcp",
    ...(chat.id ? { SUE_LAUNCHED_CHAT: chat.id } : {}),
  };
}
// ── sue launch env: pure helper END

/** The chat this server runs in: Claude Code starts one server per chat, so its env is the chat's. */
const currentChat = () => ({ id: process.env.SUE_LAUNCHED_CHAT || null, env: process.env });

/**
 * One move of one Sue's hands, with no shell: forwarded to the run's relay by the engine's own hand-move.mjs, the file
 * hand.mjs uses. A refusal is an ordinary answer, because to her it is simply what happened; a move that never reached
 * her (no such run, the relay closed, her visit over) is an error result.
 */
export async function sueMove(params, { engine = resolveSueEngine() } = {}) {
  let hands;
  try {
    hands = await import(pathToFileURL(path.join(engine.engineDir, "lib", "hand-move.mjs")).href);
  } catch {
    return toolFailure(
      "sue_move_unavailable",
      "[sue] This Sue engine has no 'move' yet, so nothing was sent.",
      `Update the sue-dredd checkout, or make the move with the shell command in her brief: node "${path.join(engine.engineDir, "hand.mjs").replace(/\\/g, "/")}" <runId> <sueId> <move> [name=value ...].`,
    );
  }
  let move;
  try {
    move = hands.moveFromParams(params);
  } catch (e) {
    return toolFailure("sue_move_invalid", `[sue] ${e.message}`, 'Example: { action:"move", runId, sue:"sue-1117-dana", move:"click", args:{ target:3 } }.');
  }
  const { reached, text } = await hands.sendMove(move, { home: engine.env?.SUE_HOME });
  if (reached) return text;
  return toolFailure("sue_move_not_delivered", `[sue] ${text}`, "The move never reached her. If her visit is over, stop moving her.");
}

/** The engine's answer to one action. `cwd` is the chat's folder: a relative `file` is where the chat wrote it. */
export async function runSue({ action, ...args }, { engine = resolveSueEngine(), cwd = process.cwd(), run = runProc } = {}) {
  if (!engine) {
    return toolFailure(
      "sue_source_missing",
      "[sue] Sue's source is not on this computer, so nothing ran.",
      "Sue runs from source only: sue/sue.mjs in the sue-dredd checkout this server lives in. SUE_ENGINE_DIR names another sue/ folder.",
    );
  }
  if (action === "move") return sueMove(args, { engine });
  if (!SUE_ACTIONS.includes(action)) {
    return toolFailure("sue_unknown_action", `[sue] unknown action "${action}".`, `Use one of: move, ${SUE_ACTIONS.join(", ")}.`);
  }
  // A file or an idea is shown through the engine's material store; an engine from before it would ignore both and
  // refuse for a missing url, which names the wrong fix.
  if ((args.file || args.idea) && !existsSync(path.join(engine.engineDir, "lib", "material.mjs"))) {
    return toolFailure(
      "sue_update_needed",
      "[sue] This Sue source cannot show a file or an idea yet, so nothing ran.",
      `Update the sue-dredd checkout (${engine.engineDir.replace(/\\/g, "/")} has no lib/material.mjs), or give a url instead.`,
    );
  }
  if (args.file) args.file = path.resolve(cwd, String(args.file));
  const starts = SUE_STARTS.includes(action);
  const argsJson = JSON.stringify(args);
  const argsFile = argsJson.length > SUE_ARGS_INLINE_MAX ? path.join(tmpdir(), `sue-args-${randomUUID()}.json`) : null;
  if (argsFile) writeFileSync(argsFile, argsJson);
  // A blind round names its folder by project (blind-round.mjs maps a project to its folder); the chat's folder would override that.
  const workspaceArgs = action === "blind_round" ? (args.workspace ? ["--workspace", String(args.workspace)] : []) : ["--workspace", cwd];
  let result;
  try {
    result = await run(
      engine.exe,
      [path.join(engine.engineDir, "sue.mjs"), action, ...workspaceArgs, ...(argsFile ? ["--json-file", argsFile] : ["--json", argsJson])],
      // A wave answers once it is up or dead (the engine waits up to 75 s for it), so it gets longer.
      { cwd, timeoutMs: starts ? 240_000 : 120_000, env: { ...engine.env, ...sueLaunchEnv(currentChat()) } },
    );
  } finally {
    if (argsFile) rmSync(argsFile, { force: true });
  }
  // The engine answers ONE JSON object on stdout; a refusal is { ok:false, error } with exit 1. It goes back as it came,
  // its words written for the caller; only an engine that crashed before answering gets the raw capture.
  const out = String(result.stdout || "").trim();
  return out.startsWith("{") ? out : fmt(`$ sue ${action}`, result);
}

const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const num = (description) => ({ type: "number", description });
const strings = (description) => ({ type: "array", items: { type: "string" }, description });
const letter = (description, extra = {}) => ({
  type: "object",
  properties: { from: { type: "string" }, subject: { type: "string" }, html: { type: "string" }, text: { type: "string" }, ...extra },
  description,
});

export const sueTool = {
  name: "sue",
  description:
    "SUE - send simulated people through a real page and read what they said. Sue runs from source only: this sue-dredd " +
    "checkout's sue/ folder. Each Sue is a real AI session with her own persona, a fresh empty browser, her own real email " +
    "inbox and a reason to be there; she never skips a step a first-time human would take. YOU are the brain by default " +
    "(brain 'chat'): follow the answer's `next` per entry of `chatBrains`, or pass dispatch:'climayte'. Each move is one " +
    "call: action:'move' with `runId`, `sue` (her id), `move` ('tools' lists them) and `args`. A refused move is an ordinary " +
    "answer; an error result means it never reached her." +
    "\n\nSTART: action:'run' with `url` and `intent` (one plain sentence on WHY these people are here), optionally `expect`. " +
    "It returns a runId in seconds; then 'status' for progress and 'report' for the verdict. 'focus_group' puts them in one " +
    "room with a moderator ('room' reads it, 'room_say' speaks into it); `file` or `idea` (with `title`) instead of `url`. " +
    "'ape' is 'run' as power users, 'art' as the design team. Roster errands: `target` + `scenario` + `personas`." +
    "\n\nPEOPLE: 'personas' lists them, 'save_persona' makes one (id, like, voice), 'edit_persona' changes one (id plus the " +
    "fields that change, or `set`). 'presue' asks who of them fits the page. 'journal' and 'scoreboard' read the history; " +
    "'profiles' lists saved logins (`profile` on a run). 'watch' opens Sue's window. 'inbox_test' is the 1-in-100 spam test " +
    "of one `email` to `count` Sues; 'inbox_test_report' reads it back. Full contract: sue/SPEC.md and sue/README.md.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["move", ...SUE_ACTIONS], description: ["move", ...SUE_ACTIONS].join(" | ") },
      sue: str("move: which Sue, by her id (e.g. sue-1117-dana; her brief names it)."),
      move: str("move: one of her hands' moves, e.g. look, click, type, scroll, note, do, done, exit_interview. 'tools' lists every one."),
      args: { type: "object", description: "move: the move's own values, e.g. { target: 3 }. Omit for a move that takes none." },
      url: str("run: the page they are trying to use."),
      file: str("run/focus_group: a PDF, picture or text file on this computer (relative to the chat's folder) instead of url."),
      idea: str("run/focus_group: a typed idea for them to react to, instead of url."),
      title: str("run/focus_group with idea: what to call the idea."),
      intent: str("run: why these people are here, one plain sentence in their terms."),
      expect: str("run/focus_group: optional, at most 300 characters: what the page is MEANT to be."),
      count: num("run: how many Sues (default 5, max 500; focus_group: default 4, max 12)."),
      focusGroup: bool("run: open a room and put every Sue in it together."),
      suggestions: strings("run/focus_group: your own hypotheses, put to the table once the Sues have looked for themselves."),
      moderator: { type: "string", enum: ["ai", "none"], description: "run/focus_group: 'ai' (default) or 'none'." },
      personas: strings("run: persona ids to send, round-robin. Default: pre-sue's pick, else this workspace's own, else the roster mix."),
      presue: bool("run/focus_group: false skips pre-sue for a run that names nobody."),
      save: bool("presue: false drafts and checks the missing people but saves nobody."),
      sampled: num("run: how many extra visitors to DRAW instead of taking from the roster. Default 0."),
      start: { type: "string", enum: ["link", "home", "inbox"], description: "run: 'link' (default), 'home' or 'inbox' (with `arrival`)." },
      arrival: letter("run, with start 'inbox': the email or post that sent her (from, subject, html or text)."),
      email: letter("inbox_test / inbox_test_report: the email exactly as it is sent.", { headers: { type: "object", description: "the message's headers" } }),
      audience: { type: "string", enum: ["cold", "known"], description: "inbox_test / inbox_test_report: 'cold' or 'known'." },
      createAccounts: bool("run: may she make an account when the page needs one (default true)."),
      owned: bool("run/focus_group: true = your own website, false = somebody else's live one. Unset: the engine decides."),
      contactSupport: bool("run: the run's own support rule when a persona says nothing about it."),
      goal: str("run: what counts as success, if not the intent itself."),
      concurrency: num("run: Sues at once. Default 'auto', sized to this machine's free memory."),
      brain: { type: "string", enum: ["chat", "openrouter", "deepseek", "local"], description: "run: 'chat' (default) = YOU are the brains." },
      dispatch: { type: "string", enum: ["climayte"], description: "run (brain 'chat'): 'climayte' = SUE sends each Sue to CliMayte itself." },
      reading: { type: "string", enum: ["paced"], description: "run: 'paced' = each Sue reads one screen at a time in real seconds." },
      profile: str("run: a saved login's name ('profiles' lists them); every Sue arrives signed in to its site."),
      target: str("run, roster errand: a roster target slug or a target file, instead of url."),
      scenario: str("run, roster errand: one of the target's errands, instead of intent."),
      forever: bool("run: keep sending Sues until 'stop' (needs a key-pool brain, not 'chat')."),
      runId: str("status/report/stop/room/room_say/move: which run. Default (status/report/stop): the latest."),
      text: str("room_say: what the host says into the room."),
      analytics: bool("report: fetch this run's ARGUS rows first and add 'What analytics saw'."),
      site: str("analytics: the ARGUS site id (default: found from the run's target hosts)."),
      project: str("analytics: the project id that owns the ARGUS site (default: the engine's own)."),
      quotes: num("report: how many of their own sentences to include (default 8)."),
      id: str("save_persona: a short slug, e.g. broker-ray. edit_persona: whom to change."),
      set: { type: "object", description: "edit_persona: any field of hers by name; null removes it." },
      builtIn: bool("edit_persona: true changes the built-in person herself, for every member."),
      displayName: str("save_persona: her name in reports."),
      like: str("save_persona: the roster persona whose body she borrows. run/focus_group: the body a named Boardroom person borrows."),
      voice: str("save_persona: who she is, second person: 'You are Ray, 54, ...'"),
      errands: strings("save_persona: her own reasons to visit (optional; a run's intent overrides)."),
      dials: { type: "object", description: "save_persona: dial overrides, e.g. {device:'phone', patienceSeconds:120}." },
      complains: bool("save_persona: her own support rule; beats the run's contactSupport."),
      persona: str("journal: whose journal."),
      limit: num("journal: how many visits, newest first (default 10)."),
      workspace: str("blind_round: the project or folder the round runs in."),
    },
    required: ["action"],
  },
  run: (params) => runSue(params),
};

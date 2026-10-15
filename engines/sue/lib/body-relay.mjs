/**
 * body-relay - lets an agent the cannon did not spawn be a Sue's brain (`--brain chat`).
 * ======================================================================================
 *
 * WHY THIS EXISTS: a CLI brain reaches her body over the MCP pipe the cannon hands it, and it
 * thinks on whichever login the cannon finds. Owner, 2026-09-22: any chat should be able to send its
 * own subagents in as the Sues, so a wave spends that chat's usage and nobody else's. A subagent has
 * no pipe to a body, so under `--brain chat` the cannon starts no brain at all: this relay opens each
 * Sue's body the first time her hands move, speaks MCP to it over stdio exactly the way the CLI would,
 * and takes the moves over HTTP on 127.0.0.1. Every rail stays in the body, so a subagent's click on
 * "Send" is refused by the same code that refuses a CLI brain's.
 *
 * The port and token live in `<runDir>/relay.json`, which only `hand.mjs` reads. A page open in her
 * own browser cannot call the relay: a request carrying an Origin is refused before the token is
 * even compared, and the token rides in a header no page can set without a preflight nobody answers.
 *
 * A Sue ends when her exit interview is written (the relay closes her body the way a finished CLI
 * does), when her brain goes quiet for `idleMs`, when one move waits on her hands that long, when no
 * brain arrives within `arriveMs`, or when the run closes; a move still waiting then is answered that
 * her visit is over. Her `ended` promise reports how many moves she made, so the cannon can tell a visitor
 * from a Sue nobody ever drove (a brain-error row the report refuses to count).
 *
 * A FOCUS GROUP (Owner, 2026-09-23) seats one more agent through the same relay: its moderator, whose
 * "body" is moderator.mjs (its own `bodyFile`) and whose visit ends when `conclude` lands (its own
 * `endsOn`), not on an exit interview. `chat-brains.json` names each entry's `role` (`sue` or
 * `moderator`) so the chat that sends the agents in can tell them apart.
 *
 * HER BODY LIVES IN THE RELAY'S OWN PROCESS (Owner, 2026-09-24: hundreds of Sues from one Chrome, as
 * cheaply as possible). A real body.mjs Sue is opened through lib/body-host.mjs's pool: the first
 * SUES_PER_HOST of them in this process (body.mjs `createSueBody`, her own browser context each), the
 * rest in host processes of their own, so no Sue pays for a node and a playwright-core of her own any
 * more (137 MB each, measured that day). Any other body file (the moderator, a spec's fake) is still
 * spawned over stdio exactly as before.
 *
 * DEPENDS ON: body.mjs's MCP surface (lib/mcp-stdio.mjs, lib/body-host.mjs). DEPENDED ON BY: cannon.mjs
 * (runSue and the focus group's moderator under `--brain chat`) and hand.mjs. Specs:
 * tests/body-relay.spec.mjs, tests/focus-group-run.spec.mjs, tests/body-host.spec.mjs.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";

import { BODY_FILE, createHostPool } from "./body-host.mjs";
import { DO_NOTE, DO_TOOL, changesScreen, destructiveMove, guardAnswer, planBatch, renumberStale } from "./move-batch.mjs";
import { MODERATOR_ID } from "./room.mjs";

export const RELAY_FILE = "relay.json";
export const CHAT_BRAINS_FILE = "chat-brains.json";

/**
 * A move this soon after the look that answered a screen-changing move is one turn of her brain's: a model
 * cannot read an answer's look and write a move from it in a second. Measured on 812 moves made right after
 * a look (round 8A and the rounds before it), with the move's own time taken off: 349 reached the relay
 * within 0.75 s of that look, all calls of one turn, and the next gap that is a decision starts at 1.25 s.
 */
const BURST_MS = 1000;
/** How long a Sue waits for her first move before she is let go as undriven. */
export const DEFAULT_ARRIVE_MS = 60 * 60 * 1000;
/** How long a Sue who has started waits between moves before she is let go where she stands. */
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;
/**
 * A focus group waits on every seat, so its limits sit below the table's (room.mjs TABLE_MAX_MS): a Sue
 * whose agent never came, or went quiet, is let go while the others are still at the table, and the
 * vote can close with them there to hear it. With the hour and fifteen minutes above, the others gave
 * up and went home first (2026-09-23 review). body-relay.spec.mjs pins both below TABLE_MAX_MS. The
 * moderator keeps the ordinary limits: it waits through the whole visit by design, and the vote closes
 * the room without it. Both clocks run from her own registration, never from when the relay opened.
 */
export const FOCUS_GROUP_ARRIVE_MS = 10 * 60 * 1000;
export const FOCUS_GROUP_IDLE_MS = 8 * 60 * 1000;
/** A body that has not exited this long after its stdin closed is killed. */
const BODY_EXIT_GRACE_MS = 30_000;
/**
 * How long ending a Sue waits for her body to close before it lets her go anyway. A spawned body is
 * killed at BODY_EXIT_GRACE_MS; a hosted one stuck under a move that never answered may never close,
 * and her visit (and the run waiting on it) must end regardless (board #7303).
 */
const BODY_CLOSE_MS = BODY_EXIT_GRACE_MS + 15_000;

/** What a Sue's let-go promise settles to: a move still waiting on her hands answers that her visit is over. */
const LET_GO = Symbol("let go");

/** Resolves true when `promise` settles within `ms`, false when it has not; never rejects. */
function within(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The move names the relay answers itself; everything else is one of the body's own tools. */
const RELAY_MOVES = new Set(["tools"]);

/**
 * `key=value` words from a shell arrive as strings. A property the body declares as a number (or a
 * number-or-text, like click's `target`) gets a number when the word is all digits; a boolean gets a
 * boolean. Text stays text, so `type target=4 text=12345` types the digits.
 */
export function coerceArgs(args, inputSchema) {
  const props = inputSchema?.properties ?? {};
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    const declared = props[key]?.type;
    const types = Array.isArray(declared) ? declared : declared ? [declared] : [];
    if (typeof value === "string" && (types.includes("number") || types.includes("integer")) && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      out[key] = Number(value.trim());
    } else if (typeof value === "string" && types.includes("boolean") && /^(true|false)$/i.test(value.trim())) {
      out[key] = value.trim().toLowerCase() === "true";
    } else out[key] = value;
  }
  return out;
}

/** One body over stdio, as an MCP client. Resolves once `initialize` and `tools/list` answered. */
export async function startBody({ bodyFile, sueDir, nodeBin = process.execPath }) {
  const child = spawn(nodeBin, [bodyFile, "--sue", sueDir], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stderrLog = fs.createWriteStream(path.join(sueDir, "body.stderr.log"), { flags: "a" });
  child.stderr.pipe(stderrLog);
  const pending = new Map();
  let nextId = 1;
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      for (const { reject } of pending.values()) reject(new Error(`her body exited (${signal ?? code})`));
      pending.clear();
      resolve({ code, signal });
    });
    child.on("error", (err) => {
      for (const { reject } of pending.values()) reject(err);
      pending.clear();
      resolve({ code: null, signal: null, error: err });
    });
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stdout is the wire; a line that is not JSON-RPC is the body's bug, not a reply
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || "the body refused the call"));
    else waiter.resolve(msg.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sue-relay", version: "1.0.0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const { tools = [] } = (await request("tools/list", {})) ?? {};
  return {
    tools,
    call: (name, args) => request("tools/call", { name, arguments: args }),
    exited,
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), BODY_EXIT_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * The run's one relay. `register` hands back a promise that settles when that Sue's visit is over;
 * `listen` opens the port and writes `relay.json`; `close` ends every Sue still open.
 */
export function createBodyRelay({
  runDir,
  bodyFile,
  arriveMs = DEFAULT_ARRIVE_MS,
  idleMs = DEFAULT_IDLE_MS,
  /** A focus group: every Sue (never the moderator) gets FOCUS_GROUP_ARRIVE_MS / FOCUS_GROUP_IDLE_MS. */
  focusGroupSeats = false,
  sweepMs = 30_000,
  closeMs = BODY_CLOSE_MS,
  now = () => Date.now(),
  startBodyImpl = null,
  /** Who starts each brain when the run starts them itself (lib/climayte-dispatch.mjs createSealedDispatcher), else null. */
  launcher = null,
}) {
  const token = crypto.randomBytes(24).toString("hex");
  const sues = new Map();
  let server = null;
  let sweeper = null;
  // The run's body hosts, opened with the first real body (see the header): this process first.
  let pool = null;
  const sameFile = (a, b) =>
    process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  const startOne =
    startBodyImpl ??
    (({ bodyFile: file, sueDir, sueId }) => {
      if (!sameFile(file, BODY_FILE)) return startBody({ bodyFile: file, sueDir });
      pool ??= createHostPool({
        local: true,
        logDir: runDir,
        say: (line) => fs.appendFileSync(path.join(runDir, "body-hosts.log"), `${new Date().toISOString()} ${line}\n`),
      });
      return pool.open({ sueId, sueDir });
    });

  function writeIndex() {
    const index = {
      runDir,
      sues: [...sues.values()].map((s) => ({
        sueId: s.sueId,
        role: s.role,
        persona: s.persona,
        brief: s.brief,
        state: s.over ? `over: ${s.why}` : s.calls ? "being driven" : "waiting for her brain",
        moves: s.calls,
        ...(s.sealed ? { sealed: s.sealed } : {}),
        ...(s.climayte ? { climayte: s.climayte } : {}),
        ...(s.dispatchError ? { dispatchError: s.dispatchError } : {}),
      })),
    };
    fs.writeFileSync(path.join(runDir, CHAT_BRAINS_FILE), `${JSON.stringify(index, null, 2)}\n`);
  }

  async function end(sue, why) {
    if (sue.over) return;
    sue.over = true;
    sue.why = why;
    sue.letGo(LET_GO);
    // A body that never started has nothing to close, and one that will not close is left behind.
    if (sue.body) await within((async () => (await sue.body).close())(), closeMs);
    writeIndex();
    launcher?.ended(sue.sueId, why);
    sue.resolveEnded({ calls: sue.calls, why });
  }

  /**
   * `bodyFile` is whose hands she moves (the relay's own body.mjs unless named: the focus group's
   * moderator is moderator.mjs); `endsOn` is the tool whose clean answer ends the visit (a Sue's
   * exit interview, the moderator's conclude); `role` is what chat-brains.json calls the entry.
   */
  function register({ sueId, sueDir, brief, persona, bodyFile: ownBody, endsOn = "exit_interview", role, sealed = null }) {
    const { promise: ended, resolve: resolveEnded } = Promise.withResolvers();
    const { promise: letGoOf, resolve: letGo } = Promise.withResolvers();
    sues.set(sueId, {
      sueId,
      sueDir,
      brief,
      persona,
      bodyFile: ownBody || bodyFile,
      endsOn,
      role: role || (sueId === MODERATOR_ID ? "moderator" : "sue"),
      /** Her sealed launch (sealedLaunch below), for a launcher that starts her brain with nothing but her hands. */
      sealed,
      body: null,
      queue: Promise.resolve(),
      calls: 0,
      batches: 0,
      lastLook: "",
      burstBasis: "",
      answeredAt: null,
      inFlight: 0,
      busySince: null,
      lastMoveAt: null,
      registeredAt: now(),
      shots: 0,
      over: false,
      why: null,
      resolveEnded,
      letGoOf,
      letGo,
    });
    writeIndex();
    // Her launcher marks her entry with the worker it started (or why it could not), for chat-brains.json.
    launcher?.offer({ sueId, role: sues.get(sueId).role, brief, sealed }, (fields) => {
      Object.assign(sues.get(sueId), fields);
      writeIndex();
    });
    return ended;
  }

  function bodyOf(sue) {
    if (!sue.body) {
      sue.body = startOne({ bodyFile: sue.bodyFile, sueDir: sue.sueDir, sueId: sue.sueId });
      // A body that dies on its own ends her visit where it stood.
      sue.body.then(
        (b) => b.exited.then(() => end(sue, sue.over ? sue.why : "her body exited")),
        () => end(sue, "her body failed to start"),
      );
    }
    return sue.body;
  }

  /** Screenshots become files she is told to Read; a shell cannot carry an image. */
  function withPictures(sue, result) {
    const content = (result?.content ?? []).map((part) => {
      if (part.type !== "image") return part;
      sue.shots += 1;
      const dir = path.join(sue.sueDir, "eyes");
      fs.mkdirSync(dir, { recursive: true });
      const ext = /png/.test(part.mimeType ?? "") ? "png" : "jpg";
      const file = path.join(dir, `${String(sue.shots).padStart(3, "0")}.${ext}`);
      fs.writeFileSync(file, Buffer.from(part.data, "base64"));
      // A must, not an offer: offered, lift-v2 round 1's drivers opened 0 to 5 of about 12, and a student asked where
      // the shark photo was while it filled her screen.
      return {
        type: "text",
        text: `[what you see: ${file.replace(/\\/g, "/")} - Read it before her next move: the words below leave out every picture and colour on her screen]`,
      };
    });
    return { content, ...(result?.isError ? { isError: true } : {}) };
  }

  /** One call to her body, its pictures turned to files; a look's words are kept for the guard in `runDo`. `batch` rides in the args so the body writes it into the move's own trace row. */
  async function callBody(sue, body, tool, args, batch = null) {
    const result = withPictures(sue, await body.call(tool, batch ? { ...args, _batch: batch } : args));
    // The words of the screen only: the picture's file name changes with every look.
    if (tool === "look" && !result.isError)
      sue.lastLook = result.content
        .map((c) => c.text ?? "")
        .filter((t) => !t.startsWith("[what you see:"))
        .join("\n");
    return result;
  }

  /** The move's own words, without the line that sends her to `look`: the answer carries the look, or none is needed. */
  const withoutCallLook = (content) =>
    content.map((part) =>
      part.type === "text" ? { ...part, text: part.text.replace(/\s*Call look(?: to see what happened)?\.?/g, "") } : part,
    );

  /**
   * A move that changed the screen answers with the look that follows it (lib/move-batch.mjs): its own
   * result line first, then the same picture and words a `look` answers with. The look is a real `look`
   * call, so its trace row and the clock's reading charge are what a separate look cost. A refused move
   * changed nothing and gets none, and neither does a visit that ended; a move after which the look reads
   * exactly what her last look read (a scroll at the bottom, a wait) answers with its own words only.
   */
  async function withLook(sue, body, result, batch = null) {
    if (result?.isError || sue.over) return result;
    const was = sue.lastLook;
    const look = await callBody(sue, body, "look", {}, batch);
    sue.answeredAt = now();
    const own = withoutCallLook(result.content);
    if (!look.isError && was && was === sue.lastLook) return { content: [...own, { type: "text", text: "The screen looks the same." }] };
    return { content: [...own, ...look.content], ...(look.isError ? { isError: true } : {}) };
  }

  /**
   * `do`: her notes and at most one move that changes the screen, answered with each result and then the
   * new look. Two screen-changing moves, or any other move, are refused with the reason (lib/move-batch.mjs
   * planBatch). Every note runs FIRST, whatever the list order, so each describes the screen she made it on
   * and all are written before any stop. A failing note stops the do before the move. A move that would make
   * a choice that cannot be undone (destructiveMove) is not made: she makes it on its own. Each trace row
   * carries the batch id as the body writes it (callBody), so nothing is rewritten afterwards.
   */
  async function runDo(sue, body, args, basis) {
    const plan = planBatch(args);
    if (plan.refusal) return { content: [{ type: "text", text: plan.refusal }], isError: true };
    const batch = (sue.batches = (sue.batches ?? 0) + 1);
    const notes = plan.moves.filter((m) => m.tool === DO_NOTE);
    const move = plan.moves.find((m) => m.tool !== DO_NOTE);
    const content = [];
    const run = async (m, spec, given = coerceArgs(m.args, spec.inputSchema)) => {
      sue.calls += 1;
      const result = await callBody(sue, body, m.tool, given, batch);
      content.push({ type: "text", text: `${m.tool}:` }, ...result.content);
      return result;
    };
    const cannot = (m) => ({ type: "text", text: `Your hands cannot "${m.tool}". Ask for tools to see what they can do.` });
    for (const [i, m] of notes.entries()) {
      const spec = body.tools.find((t) => t.name === m.tool);
      if (spec && !(await run(m, spec)).isError) continue;
      if (!spec) content.push(cannot(m));
      const moveWords = move ? `, so your move (${move.tool}) was NOT made` : "";
      content.push({ type: "text", text: `Note ${i + 1} of ${notes.length} failed${moveWords}. Fix that note and call again.` });
      return { content, isError: true };
    }
    if (!move) return { content };
    const spec = body.tools.find((t) => t.name === move.tool);
    if (!spec) return { content: [...content, cannot(move)], isError: true };
    const landed = renumberStale(basis, sue.lastLook, coerceArgs(move.args, spec.inputSchema));
    if (landed.refusal) return { content: [...content, { type: "text", text: landed.refusal }], isError: true };
    const given = {
      ...landed.args,
      ...(typeof args?.lingered === "string" && args.lingered.trim() ? { lingered: args.lingered } : {}),
      ...(typeof args?.unsure === "string" && args.unsure.trim() ? { unsure: args.unsure } : {}),
      ...(args?.considered != null && String(args.considered).trim() ? { considered: args.considered } : {}),
    };
    const choice = changesScreen(move.tool, given) ? destructiveMove(sue.lastLook, move.tool, given) : null;
    if (choice) return { content: [...content, { type: "text", text: guardAnswer(choice, move) }] };
    const result = await run(move, spec, given);
    if (result.isError) return { content, isError: true };
    return changesScreen(move.tool, given) ? await withLook(sue, body, { content }, batch) : { content };
  }

  async function move({ sue: sueId, tool, args, raw }) {
    const sue = sues.get(sueId);
    if (!sue) return { status: 404, body: { error: `no Sue ${sueId} in this run` } };
    // Why it ended rides along: three Sues' second move once answered only "Your visit is over", and
    // the reason sat in a chat-brains.json nobody at the table could see (run 20260924-175142-65f6).
    const over = () => ({
      status: 410,
      body: {
        content: [{ type: "text", text: `Your visit is over (${sue.why ?? "it was ended"}). Stop.` }],
        isError: true,
        over: true,
        why: sue.why,
      },
    });
    if (sue.over) return over();
    // The screen her brain was looking at when it made this move: moves it made together arrive together, and
    // one queued behind another that changed the page is carried over to what she saw (renumberStale). Her
    // driver's calls need not arrive at once: the shell calls of one turn reached the relay 0.1 to 0.6 s apart,
    // each after the one before was answered (round 8A), so a move that comes while another is in hand, or
    // within BURST_MS of the look that answered a move, is of the same turn and keeps that turn's first look as its basis.
    const sameTurn = sue.inFlight > 0 || (sue.answeredAt !== null && now() - sue.answeredAt < BURST_MS);
    if (!sameTurn) sue.burstBasis = sue.lastLook;
    const basis = sue.burstBasis;
    const run = async () => {
      // In flight from the moment she asks, her body's start included: the sweep lets go of a move that never answers.
      sue.inFlight += 1;
      sue.busySince = now();
      try {
        const body = await bodyOf(sue);
        const canLook = body.tools.some((t) => t.name === "look");
        if (RELAY_MOVES.has(tool)) {
          const tools = body.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
          return { tools: canLook ? [...tools, DO_TOOL] : tools };
        }
        if (tool === DO_TOOL.name && canLook) return await runDo(sue, body, args, basis);
        const spec = body.tools.find((t) => t.name === tool);
        if (!spec)
          return {
            content: [{ type: "text", text: `Your hands cannot "${tool}". Ask for tools to see what they can do.` }],
            isError: true,
          };
        sue.calls += 1;
        const asked = raw ? coerceArgs(args, spec.inputSchema) : (args ?? {});
        const landed = renumberStale(basis, sue.lastLook, asked);
        if (landed.refusal) return { content: [{ type: "text", text: landed.refusal }], isError: true };
        const given = landed.args;
        const result = await callBody(sue, body, tool, given);
        return canLook && changesScreen(tool, given) ? await withLook(sue, body, result) : result;
      } finally {
        sue.inFlight -= 1;
        sue.lastMoveAt = now();
      }
    };
    // One move at a time per Sue: two shell calls fired together still reach her hands in order.
    const turn = sue.queue.then(run, run);
    sue.queue = turn.catch(() => {});
    let result;
    try {
      // A Sue let go while this move waits on her hands is answered at once, so neither her driver nor the relay's port waits on hands that never answer.
      result = await Promise.race([turn, sue.letGoOf]);
    } catch (err) {
      return { status: 502, body: { content: [{ type: "text", text: `Her hands failed: ${err.message}` }], isError: true } };
    }
    if (result === LET_GO) return over();
    if (tool === sue.endsOn && !result.isError) await end(sue, tool === "exit_interview" ? "interviewed" : "concluded");
    else writeIndex();
    return { status: 200, body: result };
  }

  function sweep() {
    const t = now();
    for (const sue of sues.values()) {
      if (sue.over) continue;
      const seat = focusGroupSeats && sue.role === "sue";
      const arriveLimit = seat ? FOCUS_GROUP_ARRIVE_MS : arriveMs;
      const idleLimit = seat ? FOCUS_GROUP_IDLE_MS : idleMs;
      // A move that never answers ends her at the silence limit: no move takes minutes, and skipped,
      // three Sues under a print preview that never closed held the cannon open four days (board #7303).
      if (sue.inFlight) {
        if (t - sue.busySince > idleLimit) end(sue, "her hands stopped answering");
      }
      // From her own registration: a wave under a concurrency cap registers its later Sues as the
      // earlier ones finish, and timed from the relay's opening they had almost no wait at all.
      else if (!sue.body && t - sue.registeredAt > arriveLimit) end(sue, "no brain arrived");
      else if (sue.lastMoveAt !== null && t - sue.lastMoveAt > idleLimit) end(sue, "her brain went quiet");
    }
  }

  function handle(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin) return reply(403, { error: "not from a page" });
    const given = Buffer.from(String(req.headers["x-sue-token"] ?? ""));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return reply(401, { error: "wrong token" });
    if (req.method !== "POST" || req.url !== "/move") return reply(404, { error: "POST /move only" });
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      let input;
      try {
        input = JSON.parse(raw || "{}");
      } catch {
        return reply(400, { error: "the move is not JSON" });
      }
      const { status, body } = await move(input);
      reply(status, body);
    });
  }

  return {
    token,
    register,
    move,
    sweep,
    /** Where the real bodies are held: `{ n, pid, sues }` per host (this process is the first). */
    hosts: () => (pool ? pool.hosts() : []),
    async listen() {
      server = http.createServer(handle);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      fs.writeFileSync(path.join(runDir, RELAY_FILE), `${JSON.stringify({ port, token }, null, 2)}\n`);
      sweeper = setInterval(sweep, sweepMs);
      sweeper.unref?.();
      return port;
    },
    async close() {
      if (sweeper) clearInterval(sweeper);
      await Promise.all([...sues.values()].map((s) => end(s, "the run closed")));
      // After every end: a worker whose Sue was let go unfinished is cancelled before the run says it is done.
      if (launcher) await launcher.close();
      // Every Sue is closed above (or let go when her body would not close); this lets the host processes
      // go and ends anything they still hold, bounded the same way.
      if (pool) await within(pool.close(), closeMs);
      if (server) await new Promise((resolve) => server.close(resolve));
      try {
        fs.rmSync(path.join(runDir, RELAY_FILE), { force: true });
      } catch {
        /* the token file going stale is harmless: the port is closed */
      }
    },
  };
}

/**
 * Everything a subagent needs to be one Sue: who she is (the same system prompt a CLI brain gets),
 * why she came (the same first message), her hands as a shell command, and the rules a CLI brain
 * has enforced by `--tools ""` that a subagent can only be told. A focus-group Sue's ending waits for
 * the room (`focusGroup`): she leaves the website first, sits at the table until it agrees, and only
 * then gives her exit interview.
 */
/**
 * The line every Sue's system prompt carries (lib/personas.mjs), and what a chat-brain Sue is told in its
 * place: the relay answers a move that changes the screen with the look that follows it (lib/move-batch.mjs).
 * A CLI brain has no relay, so only this brief changes the sentence, never the prompt file.
 */
const LOOK_AFTER_MOVE_OLD = "Look again after anything you click or type, because the screen may have changed.";
const LOOK_AFTER_MOVE_NEW =
  "A move that changes the screen (a click, typing, a scroll, going back) answers with the new look, so you do not ask for it; look again only to see the same screen again.";
/**
 * Typed problems and the run's ledger (lib/findings.mjs problemNote, filedHereLine), said once in both briefs: the
 * fields themselves are in the note move's own description, which `move: "tools"` shows.
 */
const TYPED_PROBLEM_RULE =
  'When something on the website is wrong, her confusion, annoyance or broken line also carries `problem`, the plain facts anyone could check, written the moment they are on her screen (`move: "tools"` shows what goes in it); her `text` stays her own words. Her hands may list problems other visitors already wrote down on a page: when she runs into one, her line says `same:` its number and carries no `problem`, and she spends no move trying it again to be sure.';

const UNSURE_RULE =
  'In paced reading, once per screen, her next move of any kind (not a look) carries `lingered`: the words or numbers on that screen she read most carefully, for whatever reason (deciding if it is enough for her, comparing, checking a price, or puzzled), quoted exactly as they appear (her pointer rests on them while she reads). "none" only for a blank or loading page. Why is hers to say in a note. A move without it is refused and not made. Never invent it. If the screen has a number, limit or term she could not judge for her own situation, or would want explained before she decides, she says it as `unsure` quoting exactly that, or `unsure: "none"` if nothing does; every such move carries `unsure`, else it is refused. Never invented.';
const CONSIDERED_RULE =
  'Her `done` and `give_up` need `considered`: the number of the button or link she weighed last and decided not to press (Get Premium, Invite...), or "none" if she never weighed one; without it they are refused. On any other move she may add `considered` for a control she weighed and left.';

export function buildChatBrief({ systemPrompt, scenarioPrompt, runId, sueId, handFile, focusGroup = false, reading = null }) {
  const hand = `node "${String(handFile).replace(/\\/g, "/")}" ${runId} ${sueId}`;
  // 2026-09-24, Sue at scale: every shell move started a bash and a node and fired the chat's Bash
  // hooks, per move, per Sue. An agent that has the Connections MCP makes the move as one call to it
  // instead (the `sue` door, action 'move', through lib/hand-move.mjs like hand.mjs); the shell stays
  // for any agent without it.
  const mcp = (move, args) =>
    `connections_execute { local: true, tool_name: "sue", params: { action: "move", runId: "${runId}", sue: "${sueId}", move: "${move}"${args ? `, args: ${args}` : ""} } }`;
  // 2026-09-23: brains driven side by side staged their answers at one shared scratch path, and one
  // Sue's interview was recorded with another's answers. Her own folder is the only safe place.
  const answers = `\`exit_interview\` with every answer in one call (one JSON object is easiest there; if you write it to a file first, put that file in the folder that holds this brief, never a shared one, where the visitors running beside you would overwrite it)`;
  const ending = focusGroup
    ? `When she is finished with the website or has had enough of it, use the move that says so (\`done\` or \`give_up\`): that takes her to the table with the others. Stay there, listening (\`room wait=30\`), talking (\`say\`) and voting (\`vote\`), until the room has agreed on the biggest problem (\`room\` tells you). Then ${answers}. When it thanks you, the visit is over: reply with the single word finished.`
    : `When she is finished or has had enough, use the move that says so (\`done\` or \`give_up\`), then ${answers}. When it thanks you, the visit is over: reply with the single word finished.`;
  return `# You are one visitor to a website, played by you

For this task you are not an assistant. You are the person described below, using a real website for the first time, and every move you make on it goes through her hands. What she thinks, notices and says is the whole point: stay her from start to finish.

## Who you are

${String(systemPrompt).trim().replace(LOOK_AFTER_MOVE_OLD, LOOK_AFTER_MOVE_NEW)}

## Why you are here

${String(scenarioPrompt).trim()}

## Your hands

If you have SUE's \`move\` tool (\`mcp__sue-hands__move\`), every move is one call to it: \`runId: "${runId}"\`, \`sue: "${sueId}"\`, \`move\` (start with \`move: "tools"\`, which lists every move your hands can make, then \`move: "look"\`) and the move's values in \`args\`, for example \`move: "click", args: { target: 3 }\`. A move that shows the page answers its words and her screen's picture together, in the one answer: look at the picture before you decide her next move, every time. You never need \`move: "see"\` after a move (it answers the same picture again, changes nothing and costs her no time). If an answer gives a path instead of the picture (too big to carry), Read it. If a move answers \`Not connected\` or \`Connection closed\`, that is this machine resetting the hands' connection, not her: make one \`look\` (it changes nothing; the move may or may not have landed) and carry on from what it shows; any other error still means her visit is over. The rest of this section is for an agent without that tool.

If you have the Connections MCP (its \`connections_execute\` tool), every move is one call to it:

    ${mcp("tools")}

That lists every move your hands can make and what each one takes. Then \`move: "look"\` to see the page. Put a move's values in \`args\`, for example \`move: "click", args: { target: 3 }\` or \`move: "type", args: { target: 5, text: "hello there" }\`; the exit interview is one \`args\` object too. A refused move comes back as an ordinary answer; an error result means the move never reached her (her visit is over).

Without the Connections MCP, every move is one shell command instead:

    ${hand} <move> [name=value ...]

Start with \`${hand} tools\`, then \`${hand} look\`. For example:

    ${hand} click target=3
    ${hand} type target=5 'text=hello there'
    ${hand} scroll direction=down
    ${hand} note kind=confusion 'text=I cannot tell what this button does'

A value with spaces goes in SINGLE quotes as a whole: \`'text=two words'\`. Single, because in double quotes the shell eats a dollar sign ("$39.99" arrives as "9.99"); a value that itself holds an apostrophe goes in double quotes with any $ written as \\$. One JSON object also works in place of the name=value words; for a long one (the exit interview), write it to a file in the folder that holds this brief and pass \`"$(cat <that file>)"\`.

Type the whole command, with your own Sue id, on every move. Never keep it in a helper script, alias or file of your own: other visitors' drivers can share your scratch folders, and one that overwrites your file sends your moves into someone else's browser.

A move that changes the screen answers with its own result and then the new look, so you never need a look after it. A screen's notes and its one move can go in one \`do\`: \`move: "do", args: { moves: [{ move: "note", kind: "thought", text: "..." }, { move: "click", target: 3 }] }\`, or in a shell, \`${hand} do 'moves=[{"move":"note","kind":"thought","text":"..."},{"move":"click","target":3}]'\`. A do holds any notes and at most ONE move that changes the screen (you must see the screen between two). A lone \`note\` costs a whole turn: write a screen's notes into the \`do\` that makes her next move. A screen that offers a choice that cannot be undone (delete, remove, sign out...) stops a do before its move: make that choice as a single move.

${TYPED_PROBLEM_RULE}${
    reading === "paced"
      ? `\n\n${UNSURE_RULE}

${CONSIDERED_RULE}`
      : ""
  }

When a move shows you the page, you must see its picture before you decide her next move, every time: with the \`move\` tool the picture comes with the answer; any other door prints a file path to Read. The words leave out every photo, drawing and colour on her screen, and she sees them all. A move that is refused tells you why, the way the world would: take it as what happened and carry on from there.

## Rules that keep this a real visit

- Touch the site only through your hands (that call, or that command). Do not open a browser, fetch or curl the site, read its source code, search the web about it, or read any file except the pictures your hands give you.
- One call at a time, and wait for its answer before the next.
- Her hands refuse whatever she may not do on this visit (paying, or changing an account somebody lent her); take a refusal as what happened and never look for another way around it. What her errand asks of her on an account she made herself, such as saving her own work or writing to support, is hers to do.
- Answer only from what she saw and felt on this visit.

## Ending

${ending}
`;
}

/**
 * THE SEALED LAUNCH (Owner, 2026-10-05). Measured on run 20261005-194035-d16a: a chat-brain visitor started as
 * a full CliMayte worker carried 38.7k tokens of context before her first move (the worker's CLAUDE.md layers,
 * its tools, the brief on top) and every screen cost two requests. A sealed launch starts her brain the way a CLI
 * brain is started (SPEC.md: `--system-prompt-file`, `--setting-sources ""`, `--tools ""`, `--strict-mcp-config`)
 * with her hands as its only tool, `mcp__sue-hands__move`, bound to her (hands-mcp.mjs SUE_HANDS_RUN_ID/SUE_HANDS_SUE).
 * The cannon writes the files and names them in her chat-brains.json entry (`sealed`); the launcher (CliMayte's
 * `sealed` task option) starts the CLI with exactly those. A caller that ignores `sealed` drives her from
 * brief.md as before.
 *
 * Her system prompt is the brief made for that brain: who she is, why she came, her one tool, the rules and the
 * ending, each once, and nothing about a shell, a Read or a Connections MCP she does not have.
 */
export const SEALED_SYSTEM_FILE = "sealed-system.md";
export const SEALED_MCP_FILE = "sealed-mcp.json";
export const SEALED_SERVER = "sue-hands";
export const SEALED_TOOLS = [`mcp__${SEALED_SERVER}__move`];
export const SEALED_KICKOFF = "Your visit starts now: make her first move.";

export function buildSealedSystem({ systemPrompt, scenarioPrompt, focusGroup = false, reading = null }) {
  const answers = "`exit_interview` with every answer in one call, all of them in one `args` object";
  const ending = focusGroup
    ? `When she is finished with the website or has had enough of it, use the move that says so (\`done\` or \`give_up\`): that takes her to the table with the others. Stay there, listening (\`move: "room", args: { wait: 30 }\`), talking (\`say\`) and voting (\`vote\`), until the room has agreed on the biggest problem (\`room\` tells you). Then ${answers}. When it thanks you, the visit is over: reply with the single word finished.`
    : `When she is finished or has had enough, use the move that says so (\`done\` or \`give_up\`), then ${answers}. When it thanks you, the visit is over: reply with the single word finished.`;
  return `# You are one visitor to a website, played by you

For this task you are not an assistant. You are the person described below, using a real website for the first time, and every move you make on it goes through her hands. What she thinks, notices and says is the whole point: stay her from start to finish.

## Who you are

${String(systemPrompt).trim().replace(LOOK_AFTER_MOVE_OLD, LOOK_AFTER_MOVE_NEW)}

## Why you are here

${String(scenarioPrompt).trim()}

## Your hands

Your hands are your one tool, \`move\`: every move named above is one call to it, its name in \`move\` and its values in \`args\`, for example \`move: "click", args: { target: 3 }\` or \`move: "type", args: { target: 5, text: "hello there" }\`; the exit interview is one \`args\` object too. Start with \`move: "tools"\`, which lists every move and what each one takes, then \`move: "look"\`.

A move that shows the page answers its words and her screen's picture together, in the one answer: look at the picture before you decide her next move, every time. The words leave out every photo, drawing and colour on her screen, and she sees them all. If an answer says her picture is too big to carry, carry on from the words. A move that changes the screen answers with the new look, so never ask for a look after it.

A screen's notes and its one move go in one \`do\`: \`move: "do", args: { moves: [{ move: "note", kind: "thought", text: "..." }, { move: "click", target: 3 }] }\`. A lone \`note\` costs a whole turn: write a screen's notes into the \`do\` that makes her next move. A do holds any notes and at most ONE move that changes the screen (you must see the screen between two). A screen that offers a choice that cannot be undone (delete, remove, sign out...) stops a do before its move: make that choice as a single move.

${TYPED_PROBLEM_RULE}${
    reading === "paced"
      ? `\n\n${UNSURE_RULE}

${CONSIDERED_RULE}`
      : ""
  }

A move that is refused tells you why, the way the world would: take it as what happened and carry on from there. If a move answers \`Not connected\` or \`Connection closed\`, that is this machine resetting the hands' connection, not her: make one \`look\` (it changes nothing; the move may or may not have landed) and carry on from what it shows; any other error means her visit is over.

## Rules that keep this a real visit

- One move at a time, and wait for its answer before the next.
- Her hands refuse whatever she may not do on this visit (paying, or changing an account somebody lent her); take a refusal as what happened and never look for another way around it. What her errand asks of her on an account she made herself, such as saving her own work or writing to support, is hers to do.
- Answer only from what she saw and felt on this visit.

## Ending

${ending}
`;
}

/** Her sealed MCP config: the sue-hands server alone, bound to this run and this Sue, under the run's SUE_HOME. */
export function sealedMcpConfig({ handsFile, runId, sueId, home }) {
  return {
    mcpServers: {
      [SEALED_SERVER]: {
        command: "node",
        args: [handsFile],
        env: { SUE_HANDS_RUN_ID: runId, SUE_HANDS_SUE: sueId, ...(home ? { SUE_HOME: home } : {}) },
      },
    },
  };
}

/**
 * Writes her two sealed files into her folder and answers the `sealed` field of her chat-brains.json entry:
 * `{ systemPromptFile, mcpConfig, allowedTools, prompt }`.
 */
export function writeSealedLaunch({
  sueDir,
  systemPrompt,
  scenarioPrompt,
  focusGroup = false,
  reading = null,
  handsFile,
  runId,
  sueId,
  home,
}) {
  const systemPromptFile = path.join(sueDir, SEALED_SYSTEM_FILE);
  const mcpConfig = path.join(sueDir, SEALED_MCP_FILE);
  fs.writeFileSync(systemPromptFile, buildSealedSystem({ systemPrompt, scenarioPrompt, focusGroup, reading }));
  fs.writeFileSync(mcpConfig, `${JSON.stringify(sealedMcpConfig({ handsFile, runId, sueId, home }), null, 2)}\n`);
  return { systemPromptFile, mcpConfig, allowedTools: SEALED_TOOLS, prompt: SEALED_KICKOFF };
}

/**
 * Everything a subagent needs to be a focus group's MODERATOR: its whole job (lib/room.mjs
 * moderatorBrief, the same first message a CLI moderator gets), its hands as a shell command under the
 * seat name `moderator`, and the rules that keep it a moderator: it never sees the website, it runs
 * the room. Same shape as buildChatBrief, so both kinds of agent read one kind of brief.
 */
export function buildModeratorChatBrief({ brief, runId, handFile }) {
  const hand = `node "${String(handFile).replace(/\\/g, "/")}" ${runId} ${MODERATOR_ID}`;
  return `# You are the moderator of a focus group, played by you

For this task you are not an assistant. You run a room of people who are trying a website right now, and every move you make goes through your hands. Stay the moderator from start to finish.

${String(brief).trim()}

## Your hands

Every move is one shell command:

    ${hand} <move> [name=value ...]

Start with \`${hand} tools\` to see every move your hands can make and what each one takes. For example:

    ${hand} room wait=30
    ${hand} ask 'text=What felt off to you?'
    ${hand} propose 'problem=the price is hard to find'
    ${hand} conclude proposal=1 'summary=Three of four could not find the price. They agreed it is the one thing to fix.'

A value with spaces goes in SINGLE quotes as a whole: \`'text=two words'\`. Single, because in double quotes the shell eats a dollar sign ("$39.99" arrives as "9.99"); a value that itself holds an apostrophe goes in double quotes with any $ written as \\$. One JSON object also works in place of the name=value words; for a long one (the exit interview), write it to a file in the folder that holds this brief and pass \`"$(cat <that file>)"\`.

## Rules that keep this a real focus group

- Do not open the website, a browser, its source code or anything about it: you know it only from what the people at the table say.
- Touch the room only through that command. Read no file and run no other command.
- One move at a time, and wait for its answer before the next. While they are still on the website, listen with \`room wait=30\` again and again.
- Never put words in their mouths: the problem the room agrees on is theirs.

## Ending

When most of them back one problem, \`conclude\` with its number and a two-sentence summary. When it thanks you (or \`room\` tells you the room has already agreed), you are done: reply with the single word finished.
`;
}

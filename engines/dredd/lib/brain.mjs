// dredd/lib/brain.mjs - tool-free model calls, shared by the Boardroom's seats and secretary, the resolution loop's
// drafter and its Humanizer pass, the vision score and (through lib/jev.mjs) every typed decision. Every call goes
// through HSwarm (lib/ask.py): free of Anthropic quota, ledgered there. The old DREDD_BRAIN=opus door - a sealed
// `claude -p` on Opus 5.5 under SUE's own login - is RETIRED (the Chair, 2026-09-23: "I never want you to use, like,
// the Claude code or the GPT code CLI. You can use API keys I've given you or things like in the Z Swarm, but you're
// not allowed to use CLI logins"), and the code that opened it is gone with it. Resolves { data, answer, model,
// seconds, cost_usd, status, error } and never rejects; every call is appended to calls.jsonl when a path is given.
//
// The HSwarm door is ONE resident ask.py per process: a process per call paid ~1.6 s of interpreter start and hswarm
// import for ~0.4 s of model time, 45% of a hearing's wall clock (2026-09-22). The worker starts on the first call,
// answers calls concurrently (each tagged with its own id), and ends with closeBrain() or with this process.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

let worker = null;
// The worker's command and the grace past a call's own timeout before the call is refused. `configureWorker` is the
// test seam: a fake worker proves one call's stall never fails another call in flight (tests/brain.spec.mjs).
let workerCommand = null;
let graceS = 15;

/** Test seam: run `command` ([bin, ...args]) as the worker instead of ask.py, with `grace` seconds past each call's
 *  timeout. Called with nothing, it restores ask.py. Either way the current worker is closed first. */
export function configureWorker({ command = null, grace = 15 } = {}) {
  closeBrain();
  workerCommand = command;
  graceS = grace;
}

/**
 * Whether the room can sit now: `ask.py --capacity <profile>` reads HSwarm's own plan and each provider's resting
 * keys, no model call. Resolves { ready, resting: { provider: s }, disabled, all_resting, soonest_s } or { error } when
 * the pools cannot be read (unknown, never "resting"). The same command as the worker, so `configureWorker` stubs it.
 * Board #7040: a sitting walked into every key at its rate limit, spent its 900 s clock asleep in the zswarm's queue,
 * and filed "no ballots" as if the room had judged.
 */
export function roomCapacity({ profile = "routine", timeoutMs = 60_000 } = {}) {
  const [bin, ...argv] = workerCommand || ["python", path.join(HERE, "ask.py")];
  const r = spawnSync(bin, [...argv, "--capacity", profile], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  const line =
    String(r.stdout || "")
      .trim()
      .split(/\r?\n/)
      .pop() || "";
  try {
    const out = JSON.parse(line);
    return out?.status === "ok" ? out : { error: out?.error || `ask.py --capacity answered status ${out?.status}` };
  } catch {
    return { error: r.error ? r.error.message : `ask.py --capacity answered nothing readable (exit ${r.status})` };
  }
}

/** The worker's handles keep this process alive only while a call waits on it (node honours this; bun needs closeBrain). */
function hold(w, on) {
  for (const h of [w.child, w.child.stdin, w.child.stdout, w.child.stderr]) {
    if (on) h?.ref?.();
    else h?.unref?.();
  }
}

function startWorker() {
  const [bin, ...argv] = workerCommand || ["python", path.join(HERE, "ask.py")];
  const child = spawn(bin, argv, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const w = { child, pending: new Map(), next: 1, stderr: "", retired: false };
  const settleCall = (rid, out) => {
    const p = w.pending.get(rid);
    if (!p) return;
    w.pending.delete(rid);
    clearTimeout(p.timer);
    p.resolve(out);
    if (!w.pending.size) {
      hold(w, false);
      if (w.retired) w.child.kill();
    }
  };
  // Every call still waiting when the worker dies is answered with why, never left hanging.
  const die = (why) => {
    if (worker === w) worker = null;
    const tail = w.stderr.trim().slice(-200);
    for (const rid of [...w.pending.keys()]) settleCall(rid, { status: "error", error: `ask.py ${why}${tail ? `: ${tail}` : ""}` });
  };
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let out;
    try {
      out = JSON.parse(line);
    } catch {
      w.stderr = `${w.stderr}\nunreadable answer line: ${line.slice(0, 120)}`.slice(-2000);
      return;
    }
    const { rid, ...answer } = out;
    settleCall(rid, answer);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    w.stderr = (w.stderr + d).slice(-2000);
  });
  child.on("exit", (code, signal) => die(`exit ${code ?? signal}`));
  child.on("error", (err) => die(`could not start (${err.message})`));
  child.stdin.on("error", (err) => die(`stdin closed (${err.message})`));
  return w;
}

/**
 * Close the resident worker: its stdin ends, it answers what is in flight and exits. Every entry point that asked a
 * model calls this when it is done - node lets an idle worker go by itself, bun does not (the process waited on it
 * with nothing left to do, measured 2026-09-22).
 */
export function closeBrain() {
  if (!worker) return;
  const w = worker;
  worker = null;
  w.child.stdin.end();
  hold(w, false);
}

/** The JSON line ask.py reads. Effort is left to HSwarm's published profile unless a caller pins it; `profile`
 *  rides only with AUTO, so an explicit model pin wins. */
function hswarmSpec({ system, prompt, schema, model, timeoutS, maxTokens, reasoning, profile, images }) {
  return {
    prompt,
    system,
    schema,
    model,
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...(profile && (!model || model === "auto") ? { profile } : {}),
    max_tokens: maxTokens,
    timeout_s: timeoutS,
    // `images`: screenshot paths for rung two's vision score; HSwarm encodes them and routes AUTO to a model with eyes.
    ...(Array.isArray(images) && images.length ? { images } : {}),
  };
}

/**
 * Stop giving a worker new calls: the next call starts a fresh one. The calls it is still answering keep their own
 * timers and are never failed for another call's stall; it is killed once none is left. Until 2026-09-28 a stalled
 * call killed the worker outright, and every call waiting on it failed with "ask.py exit SIGTERM": a hearing's drafter
 * died that way the moment its call went out, and the resolution ended with no proposal.
 */
function retire(w) {
  if (worker === w) worker = null;
  w.retired = true;
  if (!w.pending.size) w.child.kill();
}

/** One HSwarm call on the resident worker. A call it has not answered by timeoutS + 15 s is refused, and the worker retired. */
function viaHswarm({ system, prompt, schema, model, timeoutS, maxTokens, reasoning, profile, images }, send = null) {
  const spec0 = hswarmSpec({ system, prompt, schema, model, timeoutS, maxTokens, reasoning, profile, images });
  if (send) return Promise.resolve(send(spec0));
  if (!worker) worker = startWorker();
  const w = worker;
  const rid = w.next++;
  const spec = { rid, ...spec0 };
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        w.pending.delete(rid);
        resolve({ status: "error", error: `ask.py did not answer in ${timeoutS + graceS} s` });
        // A worker that sat on a call past its own timeout is not trusted with the next one.
        retire(w);
      },
      (timeoutS + graceS) * 1000,
    );
    w.pending.set(rid, { resolve, timer });
    hold(w, true);
    w.child.stdin.write(`${JSON.stringify(spec)}\n`);
  }).then((out) => (out.status !== "ok" && !out.error ? { ...out, error: `ask.py answered status ${out.status}` } : out));
}

export function isLocalModel(model) {
  return /^lmstudio-/.test(String(model || ""));
}

// A local model is one GPU behind one slot pool: concurrent prompts prefill against each other and every one overruns
// its timeout (2026-10-08, five ballots at 240 s each all timed out), so local calls go one at a time.
export function mapForModel(model, items, fn) {
  if (!isLocalModel(model)) return Promise.all(items.map(fn));
  return items.reduce((chain, item) => chain.then(async (done) => [...done, await fn(item)]), Promise.resolve([]));
}

/** The output cap a cut-off structured answer is retried under, once: double the call's own, never past HSwarm's
 *  ask default. */
export const RETRY_CAP = 16000;

// The default output cap. 1200 held a free non-thinking leg's answer; since 2026-09-25 every published route is a
// thinking leg at high or max effort, whose reasoning counts against the cap: at 1200 every seat's line came back empty,
// at 8000 they answer. A cap is a ceiling, billed only as far as it is used.
// The default profile is HSwarm's widest ("routine"), so AUTO chooses among every model HSwarm has evidence for
// and fails over across them (the Chair, 2026-09-25: Dredd "should be using any of the models available in ZSwarm"); the
// narrower "decision" profile admitted DeepSeek Flash alone, and when its credit ran out Dredd could not think at all.
export async function askBrain(
  { system, prompt, schema, model = "auto", timeoutS = 120, maxTokens = 8000, reasoning = null, profile = "routine", images = null },
  callsLog = null,
  { ask = null, send = null } = {},
) {
  // `send`: a test seam that takes the worker's JSON spec in place of ask.py.
  const call =
    ask || ((tokens) => viaHswarm({ system, prompt, schema, model, timeoutS, maxTokens: tokens, reasoning, profile, images }, send));
  const out = await call(maxTokens);
  const res = settle(out, { schema, model }, callsLog);
  // A structured answer that opened its object and never closed it ran into the output cap (the drafter at 4000 did,
  // and its failure ended a resolution loop SUE had already been paid for). Asked once more with room, never again.
  if (!res.cut || maxTokens >= RETRY_CAP) return res;
  // An empty answer is reasoning that never reached the answer: double the cap would likely empty again, so full room.
  const bigger = res.empty ? RETRY_CAP : Math.min(maxTokens * 2, RETRY_CAP);
  const retried = `output cap ${maxTokens} -> ${bigger}`;
  return settle(await call(bigger), { schema, model, retried }, callsLog);
}

/**
 * When a call has not answered in `afterS`, ask once more and take whichever answers first. For the free Gemini leg:
 * over the day's 28 single asks from this checkout (2026-09-22) the median was 2.2 s and two stalled 49 s and 101 s on
 * Gemini's own side, the second holding a whole hearing's wall-clock; a hedge caps such a stall near `afterS` plus a
 * normal call, and costs a second call only on the slow tail. An error first waits for the other call; only when
 * nothing is left running is the error the answer. `ask` is injectable for the test.
 */
export function askBrainHedged(spec, callsLog = null, { afterS = 12, ask = askBrain } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let live = 0;
    let hedged = false;
    let timer = null;
    const settle = (res) => {
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const launch = () => {
      live += 1;
      Promise.resolve(ask(spec, callsLog)).then((res) => {
        live -= 1;
        if (settled) return;
        if (res.status === "ok") settle(hedged ? { ...res, hedged: true } : res);
        else if (live === 0) settle(res);
      });
    };
    launch();
    timer = setTimeout(() => {
      if (settled) return;
      hedged = true;
      launch();
    }, afterS * 1000);
  });
}

/**
 * The ONE object a model's answer text carries (the Opus brain always answers in text, and some HSwarm legs do):
 * a think block, a BOM and an outer fence are stripped, the whole text is tried strictly, then every complete
 * top-level object in it. One object, or copies of the same one, is the answer; two different ones are refused
 * rather than guessed between; an object missing a key the schema requires is refused by name. `cut` means the text
 * opened an object it never closed, which is the output cap, not a refusal. Taken from MiroFish's llm_client
 * (2026-09-23 review): the old reader sliced from the first "{" to the last "}", so a brace in the prose or a second
 * object failed the parse, and a wrong-shaped object was taken as data.
 */
export function structuredAnswer(text, schema = null) {
  let t = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const fence = t.match(/^```[a-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  if (fence) t = fence[1].trim();
  const objects = [];
  let cut = false;
  try {
    const whole = JSON.parse(t);
    if (whole && typeof whole === "object" && !Array.isArray(whole)) objects.push(whole);
  } catch {
    // Not one clean document: walk the text for complete top-level objects. Quotes count only inside an object, so
    // an apostrophe in the prose never opens a string.
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < t.length; i += 1) {
      const ch = t[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"' && depth > 0) inString = true;
      else if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj = JSON.parse(t.slice(start, i + 1));
            if (obj && typeof obj === "object" && !Array.isArray(obj)) objects.push(obj);
          } catch {
            // braces in the prose, not an object
          }
        }
      }
    }
    cut = depth > 0;
  }
  const distinct = [...new Map(objects.map((o) => [JSON.stringify(o), o])).values()];
  if (distinct.length > 1) return { data: null, cut: false, error: `${distinct.length} different JSON answers` };
  if (!distinct.length) return { data: null, cut, error: cut ? "cut off at the output cap" : "no JSON object in the answer" };
  const missing = (Array.isArray(schema?.required) ? schema.required : []).filter((k) => !(k in distinct[0]));
  if (missing.length) return { data: null, cut: false, error: `the answer is missing ${missing.join(", ")}` };
  return { data: distinct[0], cut: false, error: null };
}

/** Either door's answer, held to the schema and written to the ledger. */
function settle(out, { schema, model, retried = null }, callsLog) {
  // A schema call whose `data` did not come back structured: the answer text may still be the JSON (some legs return
  // it only as text); a truncated one is named as such, never a silent null.
  let cut = false;
  let empty = false;
  // A thinking DeepSeek leg cannot be forced onto the submit tool, so it may answer the schema in text; HSwarm
  // takes only a bare JSON document and refuses the rest before this parser (fences, prose around the object) sees it.
  if (schema && out.status === "error" && /invalid structured answer/.test(out.error || "") && String(out.answer || "").trim()) {
    const text = String(out.answer).trim();
    const got = structuredAnswer(text, schema);
    if (got.data) Object.assign(out, { data: got.data, status: "ok", error: null });
    else out.error += ` (${text.length} chars, ends "${text.slice(-60).replace(/\s+/g, " ")}" - ${got.error})`;
  } else if (
    schema &&
    out.status === "error" &&
    /invalid structured answer/.test(out.error || "") &&
    out.data &&
    typeof out.data === "object"
  ) {
    const missing = (Array.isArray(schema.required) ? schema.required : []).filter((k) => !(k in out.data));
    out.error += ` (the submit call left out ${missing.join(", ") || "nothing it names"})`;
  } else if (schema && out.status === "error" && /invalid structured answer/.test(out.error || "")) {
    // Neither text nor a submit call: the thinking ran into the cap before any answer began. Not retried with more
    // room: a ballot on 2026-09-25 thought through 8000 and then 16000 tokens alike (72 s, $0.02 each) and never voted.
    out.error += " (no answer at all - its thinking used the whole output cap)";
  }
  if (out.status === "ok" && !(out.data && typeof out.data === "object") && !String(out.answer || "").trim()) {
    // A thinking leg that spends the whole output cap on its reasoning answers "ok" with no text (2026-09-25: DeepSeek
    // V4.1 Flash at max effort, the decision profile's only route, emptied every boardroom seat at the 1200 default).
    cut = empty = true;
    out.status = "error";
    out.error = `empty answer from ${out.model || model} after ${out.seconds ?? "?"} s - its thinking used the whole output cap`;
  } else if (schema && out.status === "ok" && !(out.data && typeof out.data === "object")) {
    const text = String(out.answer || "").trim();
    const got = structuredAnswer(text, schema);
    if (got.data) out.data = got.data;
    else {
      // Dredd found this on itself (2026-09-22): the error was named but the status stayed "ok", so a caller that
      // gates on status read a failed structured answer as a success. A schema call with no structure is an error.
      cut = got.cut;
      out.status = "error";
      out.error = `no structured answer from ${out.model || model} after ${out.seconds ?? "?"} s (${text.length} chars${text.length >= 1 ? `, ends "${text.slice(-60).replace(/\s+/g, " ")}"` : ""}) - ${got.error}`;
    }
  }
  // A routed ask that failed over names the dead legs: an answer from a leg the caller did not ask for (a model with
  // no eyes scoring screenshots, 2026-09-22) must be visible in the ledger and to the caller, never a silent swap.
  const failover = Array.isArray(out.failover) ? out.failover.filter(Boolean) : [];
  const row = {
    at: new Date().toISOString(),
    model: out.model || model,
    seconds: out.seconds ?? null,
    cost_usd: out.cost_usd ?? null,
    status: out.status || "error",
    error: out.error || null,
    ...(failover.length ? { failover } : {}),
    ...(retried ? { retried } : {}),
  };
  if (callsLog) appendFileSync(callsLog, `${JSON.stringify(row)}\n`);
  return {
    data: out.data && typeof out.data === "object" ? out.data : null,
    answer: typeof out.answer === "string" ? out.answer : "",
    ...row,
    ...(cut ? { cut } : {}),
    ...(empty ? { empty } : {}),
  };
}

/** The house bans the em dash in anything a person reads; a seat's line and a proposal are both that. The
 *  non-breaking and typographic hyphens the models like (U+2010, U+2011) become the plain one. */
export function plainDashes(text) {
  return String(text || "")
    .replace(/\s*[—–]\s*/g, " - ")
    .replace(/[‐‑]/g, "-");
}

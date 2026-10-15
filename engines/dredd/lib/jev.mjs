// dredd/lib/jev.mjs - the one Node-side door to Jev, shared by the judge and its eval.
//
// Every ask is a POST to the shared HSwarm server on 127.0.0.1 (`/api/decide`: hswarm_decide's cascade, booked in the
// HSwarm ledger the same way). A Python bridge per asking process cost 64-110 MB and 0.55-1.3 CPU-seconds before its
// first answer, about 2,000 starts a day (2026-10-10). Never throws: { answers, summary, unanswered } (unanswered = the
// ids Jev left open, filled from the heuristic), or { answers: null, reason } when Jev could not answer at all, and the
// caller falls back to the bench's keyword heuristic and says so.
//
// `escalate` 0 = Jev alone (the hook); 0.7 = the measured cascade (the CLI): an unsure CHOICE is re-asked on the
// generative fallback and that answer wins. A YES/NO is never escalated: on the 39 gold asks (2026-09-22) the
// fallback's yes/no answers convened exactly the right instruments on 19, Jev's own probabilities on 39.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.HSWARM_PORT) || 7793;
const TOKEN_FILE = path.join(process.env.HSWARM_HOME || path.join(os.homedir(), ".hswarm"), "console-token");
// Connections' Jev runs on Cloudflare Workers AI (`typesafe/jev`), billed to the Connections Global LLC account, through
// the connections-jev Worker (dredd/cloudflare/jev-proxy.js; Owner, 2026-10-10). The route line
// `<worker host>:<secret>` lives outside the repo; with none, Jev runs on HSwarm's TypeSafe key pool.
const ROUTE_FILE = process.env.CONNECTIONS_JEV_ROUTE_FILE || path.join(os.homedir(), ".connections", "jev-route");
// Kept back from the budget to re-ask the cascade's items on Jev alone when the escalation leg has not answered by
// then (Jev answers an ask's whole batch in about 2 s). A third of the budget when that is smaller.
const JEV_ALONE_RESERVE_MS = 10_000;

const readLine = (file) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

/** The Worker route for jev-* models, or null. A 401/402/403 there falls to HSwarm's Clef stand-in like a refused TypeSafe key. */
function jevRoute() {
  const line = readLine(ROUTE_FILE);
  const colon = line.indexOf(":");
  if (colon <= 0 || colon === line.length - 1) return null;
  return { url: `https://${line.slice(0, colon)}/`, key: line.slice(colon + 1), provider: "cloudflare-jev" };
}

let keeper = null; // this process's one `hswarm serve-ensure`, started the first time nothing answered on the port

/**
 * Start the shared server the way a chat's MCP headersHelper does (hidden and lock-guarded; it exits once the port
 * answers, up to 30 s) and wait for it until `until`. A hook's few seconds usually end first: that ask falls back to
 * the keywords, and the next process finds the server up.
 */
async function serverStarted(until) {
  keeper ??= new Promise((resolve) => {
    const child = spawn("python", ["-m", "hswarm", "serve-ensure", "--port", String(PORT)], { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (status) => resolve(status === 0));
    child.unref();
  });
  let wall;
  const started = await Promise.race([keeper, new Promise((resolve) => (wall = setTimeout(resolve, Math.max(0, until - Date.now()), false)))]);
  clearTimeout(wall);
  return started;
}

/** One hswarm_decide call on the shared server; throws with the reason. `until` is the caller's wall as a clock time. */
async function decide(items, escalateBelow, { model, route, until }) {
  const body = JSON.stringify({ items, escalate_below: escalateBelow, ...(model ? { model } : {}), ...(route ? { jev: route } : {}) });
  for (let attempt = 0; ; attempt += 1) {
    let res;
    let text;
    try {
      res = await fetch(`http://127.0.0.1:${PORT}/api/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hswarm-token": readLine(TOKEN_FILE) },
        body,
        signal: AbortSignal.timeout(Math.max(1, until - Date.now())),
      });
      text = await res.text();
    } catch (error) {
      if (error.name === "TimeoutError") throw new Error("hswarm decide: timed out", { cause: error });
      if (res) throw new Error(`hswarm /api/decide: ${error.message}`, { cause: error });
      if (attempt === 0 && (await serverStarted(until))) continue;
      throw new Error(`no hswarm server answered on 127.0.0.1:${PORT} (${error.cause?.code || error.message})`, { cause: error });
    }
    let out = {};
    try {
      out = JSON.parse(text);
    } catch {
      // a body that is not JSON is reported by its status below
    }
    if (!res.ok) throw new Error(`hswarm /api/decide answered ${res.status}: ${String(out.error || text).slice(0, 160)}`);
    return out;
  }
}

/**
 * @param items  the typed questions (lib/docket.mjs buildQuestions)
 * @param escalate  0 = Jev alone; 0.7 = the measured cascade (unsure choices re-asked on the generative fallback)
 * @param timeoutMs  hard wall for the whole call
 * @param model  the typed model for this one ask (the model ladder's rung); unset, DREDD_JEV_MODEL or HSwarm's default
 *   (the pinned Jev version SIT and the 0.7 cascade were tuned on). A Simple Jev id such as
 *   featherless-ai/Qwen3.8-27B-classifier goes to Featherless's keyless demo, clef or clef-flash to Workers AI: A/Bs only.
 */
export async function askJev(items, { escalate = 0.7, timeoutMs = 40_000, model = null } = {}) {
  if (!items?.length) return { answers: null, reason: "no items" };
  const until = Date.now() + timeoutMs;
  model ||= process.env.DREDD_JEV_MODEL || null;
  const route = jevRoute();
  const askGroup = async (group, below) => {
    if (below <= 0) return decide(group, 0, { model, route, until });
    // The escalation leg gets the budget minus a reserve; past it, the group is re-asked on Jev alone.
    const left = until - Date.now();
    try {
      return await decide(group, below, { model, route, until: until - Math.min(JEV_ALONE_RESERVE_MS, left / 3) });
    } catch (error) {
      return unescalated(await decide(group, 0, { model, route, until }), below, error.message);
    }
  };
  let outs;
  try {
    outs = await Promise.all(planCalls(items, escalate).map(([group, below]) => askGroup(group, below)));
  } catch (error) {
    return { answers: null, reason: error.message, summary: null };
  }
  const answers = shapeAnswers(outs.flatMap((out) => out.answers || []));
  const summary = mergeSummaries(outs.map((out) => out.summary || {}));
  // The bill labels Jev's calls as Cloudflare's (lib/hearing.mjs jevCallRow); the server takes the route for jev-* only.
  if (route && (!model || model.startsWith("jev-"))) summary.jev_route = route.provider;
  const unanswered = items.map((i) => i.id).filter((id) => answers[id]?.answer == null);
  // A failed pick still spent something (Jev's calls, a fallback's): the summary rides along so the bill counts it.
  if (unanswered.length === items.length) return { answers: null, reason: "Jev answered nothing (no working key or no network)", summary };
  return { answers, summary, unanswered, reason: null };
}

/**
 * The decide calls for one ask: every yes/no item on Jev alone (escalate_below 0), every choice or score item through
 * the cascade at `escalate`. A yes/no is never escalated (the measurement in this file's header). No empty call.
 */
function planCalls(items, escalate) {
  const yesno = items.filter((i) => i.type === "yesno");
  const rest = items.filter((i) => i.type !== "yesno");
  return [
    [yesno, 0],
    [rest, escalate],
  ].filter(([group]) => group.length);
}

/**
 * The cascade's items, re-asked on Jev alone after the escalation leg failed or ran out of time, kept the way HSwarm
 * keeps a failed escalation: Jev's confident answers stand, an answer under `below` is left unanswered (the caller's
 * keywords fill it and say so), and the summary names the failure. Before, the whole call died with it: on 2026-09-27
 * no decision route had a usable key, the general-profile stand-in reasoned past every deadline, and every CLI docket
 * and eval threw away all of Jev's answers, yes/no included, for the keyword heuristic.
 */
function unescalated(out, below, why) {
  for (const row of out.answers || []) {
    const confidence = row.jev?.confidence;
    if (confidence == null || confidence < below) row.answer = null;
  }
  out.summary = { ...out.summary, escalation_failed: why.slice(0, 160) };
  return out;
}

/** One summary for the docket and the bill: numbers add up (items, costs, escalations), anything else is kept from the first call that has it. */
function mergeSummaries(summaries) {
  const merged = {};
  for (const s of summaries)
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === "number" && typeof (merged[k] ?? 0) === "number") merged[k] = (merged[k] ?? 0) + v;
      else if (!(k in merged)) merged[k] = v;
    }
  return merged;
}

/**
 * hswarm decide rows -> {id: {answer, confidence, probabilities, source}}. Only a choice item can come back from the
 * fallback (yes/no items are never escalated, planCalls). Its answer is the fallback's, so Jev's own probabilities - a
 * different, unsure answer - move under jev_* keys and the shaped row carries none: the docket reads a choice by its answer.
 */
function shapeAnswers(rows) {
  const answers = {};
  for (const row of rows) {
    const jev = row.jev || {};
    const source = row.source || "";
    const shaped = { answer: row.answer ?? null, confidence: jev.confidence ?? null, probabilities: jev.probabilities || {}, source };
    if (row.answer != null && !source.startsWith("jev")) {
      shaped.jev_confidence = shaped.confidence;
      shaped.jev_probabilities = shaped.probabilities;
      shaped.confidence = null; // the fallback states no confidence of its own
      shaped.probabilities = {};
    }
    answers[row.id] = shaped;
  }
  return answers;
}

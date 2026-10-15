/**
 * SUE's chat-brain visitors on CliMayte, SEALED (Owner, 2026-10-06: "no chat ever runs one the expensive way again").
 *
 * A sealed visitor is one CliMayte task whose brain holds her system prompt and her hands (the sue-hands MCP server)
 * and nothing else: the run writes both files into her folder (lib/body-relay.mjs writeSealedLaunch) and lists them as
 * the `sealed` field of her chat-brains.json entry. Measured 2026-10-06 (run 20261006-041030-f5fb): 6,000 tokens of
 * context before her first move (38,700 as an ordinary worker), median 22,800 (72,000), 1.34M re-read tokens a visit
 * (6.84M), 59 requests (98), and the full exit interview.
 *
 * This file is the one place that knows the task's shape and AgentHydra's CliMayte API (its CLIMAYTE doc, not in this repo,
 * "Sealed tasks" and the HTTP routes): the text a run tells its caller (`climayteRunCall`), the tasks it builds
 * (`tasksFor`), and the dispatcher the cannon runs under `--dispatch climayte` (`createSealedDispatcher`), which POSTs
 * each Sue to `POST /api/corch/workers` as she registers, so one command gets driven visitors. A run started without
 * the flag can be handed over later: `node sue/dispatch.mjs <runId>` writes the run's dispatch.json, which the
 * cannon's dispatcher watches for. A focus group's moderator has no sealed launch (it reads a brief and works a shell
 * command), so it goes as one ordinary task.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SUE_DEFAULT_MODEL } from "./claude-cli.mjs";

export const CLIMAYTE_URL_DEFAULT = "http://127.0.0.1:7787";
/**
 * Every Sue runs on Sonnet 5.5 (Owner, 2026-10-05), named by its full id so the model CliMayte answers it was put on
 * compares exactly, at the CLI's default effort (she names none). AgentHydra holds a sealed task's named model and
 * effort; before it did (2026-10-07), the `modelWhy` held nothing and every Sue ran on the code scorecard's pick, so the
 * dispatcher checks both on each worker. Every cheaper arm lost its A/B on radiologistbuddy (2026-10-07, eval/ab-ledger.jsonl):
 * Sonnet 5.5 low finished less, Sonnet 5.5 medium and Haiku 5.5 max saved no quota, and Haiku 5.5 high, about a quarter
 * of the quota, rated the same site 0.33 stars lower (resolved) and lost one visit's exit interview in 12.
 */
export const SEALED_MODEL = SUE_DEFAULT_MODEL;
export const SEALED_MODEL_WHY = "SUE visitors run on Sonnet 5.5 (owner 2026-10-05)";
/**
 * A Sue's queue priority in CliMayte (0 is its default; higher starts first). Her run already holds a browser and a
 * round's clock while she waits, so she goes ahead of default batch work: on 2026-10-12 a Raise Buddy re-visit's three
 * seats sat queued behind 40 review tasks until each was raised to 8 by hand with climayte_priority.
 */
export const SEALED_PRIORITY = 8;
/** Sealed tasks arrived in AgentHydra 1.11.0; an older one would run the kickoff line as an ordinary worker. */
export const SEALED_MIN_VERSION = "1.11.0";
/** In the run's folder: present = SUE sends this run's visitors to CliMayte itself. */
export const DISPATCH_FILE = "dispatch.json";
export const DISPATCH_POLL_MS = 2000;
/**
 * A round's Sues arrive within seconds of each other and AgentHydra can miss a 1.5 s health probe under that burst
 * (lift-v2-engine, 2026-10-07: 2 of 8 Sues left "waiting for her brain" by the dispatcher, then 3 of 8 refused at
 * start by sue.mjs). Silence is asked again this many times in all, DISPATCH_RETRY_MS, then twice that, then three
 * times apart (12 s at most); an answer is final.
 */
export const DISPATCH_READY_TRIES = 4;
export const DISPATCH_RETRY_MS = 2000;
const PROBE_TIMEOUT_MS = 1500;
const POST_TIMEOUT_MS = 30_000;
/** A worker on a brain its Sue did not name, left running because a cancel failed, would drive her: asked this often. */
const CANCEL_TRIES = 3;
/** How a visit ends on its own (lib/body-relay.mjs end): her worker finishes by itself and is never cancelled. */
const CLEAN_ENDS = new Set(["interviewed", "concluded"]);
const VISITOR_WAIT_MS = 20 * 60 * 1000;

export function climayteUrl(env = process.env) {
  return String(env.SUE_CLIMAYTE_URL || CLIMAYTE_URL_DEFAULT).replace(/\/+$/, "");
}

export function climayteGroup(runId) {
  return `sue-${runId}`;
}

function versionAtLeast(version, min) {
  const parts = (v) =>
    String(v ?? "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(version), parts(min)];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

async function timed(fetchImpl, url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `{ ready: true, version, url }` when AgentHydra answers and can seal a task, else `{ ready: false, why, url }`, with
 * `silent: true` when nothing answered in DISPATCH_READY_TRIES asks (an AgentHydra too old to seal is an answer, final
 * at once).
 */
export async function climayteReady({
  base = climayteUrl(),
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  tries = DISPATCH_READY_TRIES,
  retryMs = DISPATCH_RETRY_MS,
} = {}) {
  let r = await probeOnce({ base, fetchImpl, timeoutMs });
  for (let tried = 1; !r.ready && r.silent && tried < tries; tried++) {
    await new Promise((done) => setTimeout(done, retryMs * tried));
    r = await probeOnce({ base, fetchImpl, timeoutMs });
  }
  return r;
}

async function probeOnce({ base, fetchImpl, timeoutMs }) {
  try {
    const res = await timed(fetchImpl, `${base}/api/health`, {}, timeoutMs);
    const body = res.ok ? await res.json() : null;
    if (body?.service !== "agenthydra") return { ready: false, silent: true, url: base, why: `AgentHydra did not answer at ${base}` };
    if (!versionAtLeast(body.version, SEALED_MIN_VERSION))
      return { ready: false, url: base, why: `AgentHydra ${body.version} at ${base} cannot seal a task (needs ${SEALED_MIN_VERSION})` };
    return { ready: true, url: base, version: body.version };
  } catch {
    return { ready: false, silent: true, url: base, why: `AgentHydra did not answer at ${base}` };
  }
}

/** One Sue as one sealed CliMayte task. Her folder is the cwd only because the API wants one: a sealed task's is never read. */
export function sealedTask(entry, { runId }) {
  const { systemPromptFile, mcpConfig, allowedTools, prompt } = entry.sealed;
  return {
    title: `Sue ${entry.sueId} ${runId} SEALED`,
    prompt,
    cwd: path.dirname(systemPromptFile),
    sealed: { systemPromptFile, mcpConfig, allowedTools },
    model: SEALED_MODEL,
    modelWhy: SEALED_MODEL_WHY,
    priority: SEALED_PRIORITY,
  };
}

/** A focus group's moderator: an ordinary task in an empty folder (no repo instructions to load) that reads its brief. */
export function moderatorTask(entry, { runId, cwd = os.tmpdir() }) {
  return {
    title: `SUE moderator ${runId}`,
    prompt: `Read your brief file ${entry.brief} whole, to its last line (in parts with offset and limit if one Read will not hold it), then do what it says.`,
    cwd,
    model: SEALED_MODEL,
    modelWhy: SEALED_MODEL_WHY,
    priority: SEALED_PRIORITY,
  };
}

/** The task for one chat-brains.json entry, or null when it is over or has nothing CliMayte can launch. */
export function taskFor(entry, { runId }) {
  if (String(entry.state ?? "").startsWith("over")) return null;
  if (entry.sealed) return sealedTask(entry, { runId });
  if (entry.role === "moderator" && entry.brief) return moderatorTask(entry, { runId });
  return null;
}

/** Every launchable entry of a chat-brains.json index not already sent to CliMayte. */
export function tasksFor(index, { runId }) {
  const out = [];
  for (const entry of index?.sues ?? []) {
    if (entry.climayte) continue;
    const task = taskFor(entry, { runId });
    if (task) out.push({ sueId: entry.sueId, task });
  }
  return out;
}

/** POSTs tasks as one CliMayte group; resolves the made workers in task order, throws with AgentHydra's own words. */
export async function postTasks({ tasks, group, base = climayteUrl(), fetchImpl = fetch }) {
  let res;
  try {
    res = await timed(
      fetchImpl,
      `${base}/api/corch/workers`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks, group }) },
      POST_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(`CliMayte at ${base} did not answer (${err?.message ?? err})`, { cause: err });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.workers)) throw new Error(`CliMayte refused the tasks: ${body?.error ?? `HTTP ${res.status}`}`);
  return body.workers;
}

/** Cancels CliMayte workers by `{ id }` or `{ group }`; a failure is reported, never thrown (the run is ending anyway). */
export async function cancelWorkers(filter, { base = climayteUrl(), fetchImpl = fetch } = {}) {
  try {
    const res = await timed(
      fetchImpl,
      `${base}/api/corch/cancel`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(filter) },
      POST_TIMEOUT_MS,
    );
    const body = await res.json().catch(() => null);
    return res.ok ? { ok: true, cancelled: body?.cancelled ?? [] } : { ok: false, why: body?.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) };
  }
}

/** The exact climayte_run call for one Sue, in the words a run's `next` hands its caller. */
export function climayteRunCall({ runId, chatBrains }) {
  return (
    `climayte_run { group: "${climayteGroup(runId)}", tasks: [{ title: "Sue <sueId> ${runId} SEALED", prompt: <sealed.prompt>, cwd: <her folder, the folder of sealed.systemPromptFile>, ` +
    `sealed: { systemPromptFile: <sealed.systemPromptFile>, mcpConfig: <sealed.mcpConfig>, allowedTools: <sealed.allowedTools> }, model: "${SEALED_MODEL}", modelWhy: "${SEALED_MODEL_WHY}", priority: ${SEALED_PRIORITY} }] }` +
    `, one task per entry of ${chatBrains} that carries a \`sealed\` field (fill each <...> from her entry)`
  );
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Asks a run to send its visitors to CliMayte (what `dispatch.mjs` writes); the cannon's dispatcher answers `acceptedAt`. */
export function requestDispatch(runDir, { by, now = () => new Date() } = {}) {
  const file = path.join(runDir, DISPATCH_FILE);
  const prior = readJsonFile(file);
  if (prior) return prior;
  const asked = { to: "climayte", by: by ?? "dispatch.mjs", askedAt: now().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(asked, null, 2)}\n`);
  return asked;
}

export function readDispatch(runDir) {
  return readJsonFile(path.join(runDir, DISPATCH_FILE));
}

/**
 * The cannon's side (lib/body-relay.mjs calls it): `offer(entry, mark)` as each Sue registers, `ended(sueId, why)` as
 * her visit ends, `close()` with the relay. Off until the run asks (`enabled`, the cannon's `--dispatch climayte`) or a
 * dispatch.json appears in the run's folder; then every registered Sue still waiting is POSTed once, the later ones as
 * they register. `mark` writes `climayte: { worker, group, model, effort }` (what CliMayte runs her on) or
 * `dispatchError` onto her chat-brains.json entry; a Sue CliMayte put on a model or effort other than the ones she named
 * is cancelled at once (a failed cancel is asked again) with a `dispatchError`. A worker whose Sue was let go without finishing is cancelled; one whose Sue
 * finished ends by itself.
 */
export function createSealedDispatcher({
  runDir,
  runId,
  enabled = false,
  base = climayteUrl(),
  fetchImpl = fetch,
  log = () => {},
  pollMs = DISPATCH_POLL_MS,
  retryMs = DISPATCH_RETRY_MS,
  visitorWaitMs = VISITOR_WAIT_MS,
  now = () => new Date(),
}) {
  const group = climayteGroup(runId);
  const pending = new Map();
  const workers = new Map();
  let on = false;
  let readiness = null;
  let chain = Promise.resolve();
  let poller = null;
  const settling = new Set();
  const track = (p) => {
    settling.add(p);
    p.finally(() => settling.delete(p));
    return p;
  };

  function accept(by) {
    const file = path.join(runDir, DISPATCH_FILE);
    const asked = readJsonFile(file) ?? { to: "climayte", by, askedAt: now().toISOString() };
    fs.writeFileSync(file, `${JSON.stringify({ ...asked, group, url: base, acceptedAt: now().toISOString() }, null, 2)}\n`);
  }

  function flush() {
    chain = chain.then(async () => {
      if (!on || !pending.size) return;
      // A ready AgentHydra is remembered; a failed probe is not, so a Sue who arrives later asks again.
      if (!readiness?.ready) readiness = await climayteReady({ base, fetchImpl, retryMs });
      const batch = [...pending.entries()];
      pending.clear();
      const fail = (why) => {
        for (const [, { mark }] of batch) mark({ dispatchError: why });
        log(`climayte: ${batch.length} not sent: ${why}`);
      };
      if (!readiness.ready) return fail(readiness.why);
      let made;
      try {
        made = await postTasks({ tasks: batch.map(([, p]) => p.task), group, base, fetchImpl });
      } catch (err) {
        return fail(err.message);
      }
      const sent = [];
      for (const [i, [sueId, { task, mark }]] of batch.entries()) {
        const id = made[i]?.id ?? null;
        const ran = { model: made[i]?.model ?? null, effort: made[i]?.effort ?? null };
        // A sealed Sue's model and effort are promised (AgentHydra holds them); a moderator is an ordinary task, so only
        // recorded. Run 20261007-175128-86d3 drove two Sues at Sonnet low while the model alone was checked.
        if (task.sealed && (ran.model !== task.model || ran.effort !== (task.effort ?? null))) {
          let r = await cancelWorkers({ id }, { base, fetchImpl });
          for (let tried = 1; !r.ok && tried < CANCEL_TRIES; tried++) {
            await new Promise((done) => setTimeout(done, retryMs * tried));
            r = await cancelWorkers({ id }, { base, fetchImpl });
          }
          const named = task.effort ? `${task.model} ${task.effort}` : `${task.model} at the CLI's default effort`;
          const why =
            `CliMayte put her on ${[ran.model ?? "a model it did not name", ran.effort].filter(Boolean).join(" ")}, not ${named}: ` +
            `its AgentHydra predates holding a sealed task's setting, so update it (worker ${id} ${r.ok ? "cancelled" : `not cancelled: ${r.why}`})`;
          mark({ dispatchError: why });
          log(`climayte: ${sueId} not sent: ${why}`);
          continue;
        }
        const bound = setTimeout(() => {
          const w = workers.get(sueId);
          if (!w || w.done || w.cancelled) return;
          for (const other of workers.values()) other.cancelled = true;
          track(
            chain.then(async () => {
              const r = await cancelWorkers({ group }, { base, fetchImpl });
              log(
                `climayte: ${sueId} waited past ${visitorWaitMs / 60000} min; group ${group} ${r.ok ? "cancelled" : `not cancelled (${r.why})`}`,
              );
            }),
          );
        }, visitorWaitMs);
        bound.unref?.();
        workers.set(sueId, { id, cancelled: false, done: false, bound });
        mark({ climayte: { worker: id, group, ...ran } });
        sent.push(`${sueId} as ${id} on ${[ran.model, ran.effort].filter(Boolean).join(" ")}`);
      }
      if (sent.length) log(`climayte: sent ${sent.join(", ")} (group ${group}, sealed)`);
    });
    return track(chain);
  }

  function turnOn(by) {
    if (on) return;
    on = true;
    if (poller) clearInterval(poller);
    poller = null;
    accept(by);
    log(`climayte: this run's visitors go to CliMayte sealed (group ${group}, ${base})`);
    flush();
  }

  if (enabled) turnOn("cannon --dispatch climayte");
  else {
    poller = setInterval(() => {
      if (fs.existsSync(path.join(runDir, DISPATCH_FILE))) turnOn("dispatch.json");
    }, pollMs);
    poller.unref?.();
  }

  return {
    group,
    enabled: () => on,
    offer(entry, mark) {
      const task = taskFor(entry, { runId });
      if (!task) return null;
      pending.set(entry.sueId, { task, mark });
      return on ? flush() : null;
    },
    ended(sueId, why) {
      pending.delete(sueId);
      const w = workers.get(sueId);
      if (!w || w.cancelled || w.done) return null;
      clearTimeout(w.bound);
      if (CLEAN_ENDS.has(why)) {
        w.done = true;
        return null;
      }
      w.cancelled = true;
      return track(
        chain.then(async () => {
          const r = await cancelWorkers({ id: w.id }, { base, fetchImpl });
          log(`climayte: ${sueId}'s worker ${w.id} ${r.ok ? "cancelled" : `not cancelled (${r.why})`}: ${why}`);
        }),
      );
    },
    async close() {
      if (poller) clearInterval(poller);
      poller = null;
      for (const w of workers.values()) clearTimeout(w.bound);
      await chain;
      await Promise.all([...settling]);
      if (![...workers.values()].some((w) => !w.done && !w.cancelled)) return;
      const r = await cancelWorkers({ group }, { base, fetchImpl });
      log(`climayte: the run ended with workers still going; group ${group} ${r.ok ? "cancelled" : `not cancelled (${r.why})`}`);
    },
  };
}

/**
 * field - the front half of the owner's review pipeline through one door (2026-10-10): Jev names the product's scope,
 * pre-sue picks SUE's visitors for that scope, SUE goes first, ART follows when Jev reads design trouble in her claims,
 * APE goes on the rule in apeDecision, and every finding goes to the Boardroom once, in ONE docket
 * (`dredd.mjs --run sue:<id>,art:<id>,ape:<id> --field <field.json>`). It sits beside SUE, not in Dredd's convene,
 * because convene starts every instrument at once and never waits on one's findings to choose the next. Each decision
 * is recorded with its reason. Pure but for the injected doors. The rules and the owner's words are in
 * sue/README.md "Field"; the spec is tests/field.spec.mjs.
 */
import { presueState } from "./presue.mjs";
import { hostOfUrl } from "./site-owner.mjs";

/** The kinds of product Jev chooses between, each with what it means (said to Jev, and ridden into pre-sue). */
export const SCOPE_SAYS = Object.freeze({
  medical: "health or medical: patients, carers or clinicians use it for symptoms, care, treatment or health records",
  education: "education: students, teachers or parents use it for learning, school or courses",
  kids: "made for children to use themselves",
  finance: "money: banking, payments, budgeting, investing, taxes or insurance",
  "business-tool": "a tool for work: a team, a trade, a shop or an operator uses it on the job",
  "developer-tool": "a tool for programmers or technical staff",
  "general-consumer": "an everyday app or site for ordinary people, used at home or in daily life",
  entertainment: "games, media or fun",
});
export const SCOPES = Object.freeze(Object.keys(SCOPE_SAYS));

export const SCOPE_QUESTION = `What kind of product is this, going by the page and why its visitors come? ${SCOPES.map((s) => `${s} = ${SCOPE_SAYS[s]}`).join("; ")}.`;

/** The APE rule's one judgment: is a familiar power user one of this product's real visitors. */
export const REPEAT_QUESTION =
  "Do this product's real visitors come back to it again and again - every day or every week, as part of their work or life - so that someone who already knows it well and moves fast is one of its real visitors, rather than a product a person uses once or rarely?";

/** One per claim SUE filed: is it about how the screen looks and is laid out (ART's field), or something else. */
export const DESIGN_QUESTION =
  "Is this visitor's complaint about the DESIGN of the screen - how it looks or is laid out (visual hierarchy, spacing, sizes, contrast, colour, type, crowding, where things sit, a control that does not look like what it does) - rather than a bug, a missing feature, wrong data, the wording, or speed? The complaint:";

/** Jev's yes-probability that makes an answer a yes (pre-sue's FIT_BAR, Dredd's seat bar: one scale). */
export const REPEAT_BAR = 0.5;
export const DESIGN_BAR = 0.5;
/** How many of SUE's claims must read design before ART goes: "If she had design issues, we would run Art." */
export const ART_MIN_DESIGN = 1;
/** Field runs on a site since APE last went before it goes again: 1 for a repeat-use product, 3 for anything else. */
export const APE_GAP = Object.freeze({ repeatUse: 1, other: 3 });
/** The most claims one Jev call reads for the ART decision; any more are named as not asked. */
export const DESIGN_CLAIMS_MAX = 80;
/** How many visitors SUE's wave sends when the caller names no count: pre-sue's three kinds of visitor. */
export const FIELD_COUNT = 3;
/** The field runs on record, one row per run that started a wave: what the APE rule counts. Under SUE's state folder. */
export const FIELD_LEDGER = "ledger.jsonl";
/** How much of a claim Jev reads. */
const CLAIM_CHARS = 400;

/**
 * The floor with no Jev for the ART decision: a claim whose own words name the look or the layout. Structural and
 * named in the record, like pre-sue's floor; never a reason to skip Jev when Jev answers.
 */
export const DESIGN_WORDS =
  /\b(layout|laid out|spacing|crowded|cluttered|cramped|font|typeface|text (?:is |was )?(?:too )?(?:small|tiny|faint)|contrast|colou?rs?|alignment|misaligned|overlap\w*|hierarchy|visual\w*|looks? like|hard to see|hard to read|buried|icon|whitespace|white space|button (?:is |was )?(?:too )?(?:small|tiny))\b/i;

const clip = (s, n) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const round2 = (p) => Math.round(p * 100) / 100;
const yesOf = (row) => {
  const p = row?.probabilities?.yes;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
};

/** The two questions asked of the page before anybody goes: its scope and whether its visitors come back. */
export function scopeQuestions(state) {
  return [
    { id: "scope", state, type: "choice", question: SCOPE_QUESTION, options: [...SCOPES] },
    { id: "repeat-use", state, type: "yesno", question: REPEAT_QUESTION },
  ];
}

/**
 * The scope Jev chose, `{ answer, says, p, by: "jev" }`, or `{ answer: null, by: "none", note }` when Jev gave none: an
 * unread scope is said, never guessed, and pre-sue then fits the visitors on the page and the errand alone.
 */
export function decideScope(answers, reason = null) {
  const row = answers?.scope;
  const answer = SCOPES.includes(row?.answer) ? row.answer : null;
  if (!answer)
    return {
      answer: null,
      says: null,
      by: "none",
      note: `Jev named no scope (${reason || "no answer"}), so pre-sue fits the visitors on the page and the errand alone`,
    };
  const p = typeof row.confidence === "number" ? row.confidence : (row.probabilities?.[answer] ?? null);
  return { answer, says: SCOPE_SAYS[answer], ...(p == null ? {} : { p: round2(p) }), by: "jev" };
}

/** Whether visitors come back to it: Jev's yes at REPEAT_BAR, or, with no answer, no (the longer gap), said. */
export function decideRepeat(answers, reason = null) {
  const p = yesOf(answers?.["repeat-use"]);
  if (p == null)
    return { answer: false, by: "floor", note: `Jev did not answer (${reason || "no answer"}), so it counts as a product people use once` };
  return { answer: p >= REPEAT_BAR, p: round2(p), by: "jev" };
}

/** This site's field runs on record, oldest first, from the ledger's rows (any order). Pure. */
export function siteHistory(rows, host) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.host === host).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * The APE rule, whole: the caller's `ape` (true or false) wins; otherwise APE goes once this site has had `gap` field
 * runs without it (every one, when it never went): APE_GAP.repeatUse for a product its visitors come back to, else
 * APE_GAP.other. So a site's first field run is SUE's, a daily-use tool gets APE every other run, anything else every
 * fourth. Only field runs count (FIELD_LEDGER). `{ goes, by, why, gap?, since? }`.
 */
export function apeDecision({ caller = null, repeat, history = [] }) {
  if (caller === true) return { goes: true, by: "caller", why: "the caller sent APE (ape: true)" };
  if (caller === false) return { goes: false, by: "caller", why: "the caller kept APE home (ape: false)" };
  const gap = repeat?.answer ? APE_GAP.repeatUse : APE_GAP.other;
  let since = 0;
  for (let i = history.length - 1; i >= 0 && history[i].ape !== true; i -= 1) since += 1;
  const kind = repeat?.answer ? "a product its visitors come back to again and again" : "a product people use once or rarely";
  const count = `${since} field run${since === 1 ? "" : "s"} on this site since APE ${history.some((r) => r.ape === true) ? "last went" : "ever went (never)"}`;
  const goes = since >= gap;
  return {
    goes,
    by: "rule",
    gap,
    since,
    why: `${kind} (${repeat?.by === "jev" ? `Jev ${repeat.p}` : "no Jev"}): APE goes after ${gap} field run${gap === 1 ? "" : "s"} without it; ${count}, so APE ${goes ? "goes" : "stays home this run"}`,
  };
}

/** One yes/no per claim SUE filed (at most DESIGN_CLAIMS_MAX), all on the page's state. */
export function designQuestions(claims, state) {
  return claims
    .slice(0, DESIGN_CLAIMS_MAX)
    .map((c) => ({ id: `design:${c.id}`, state, type: "yesno", question: `${DESIGN_QUESTION} ${clip(c.text, CLAIM_CHARS)}` }));
}

/**
 * The ART decision over SUE's claims: `{ goes, by, why, asked, design: [{ id, text, p?, by }] }`. A claim Jev left
 * unanswered (or every claim, with no Jev) is read by DESIGN_WORDS, and says so.
 */
export function artDecision({ claims, answers = null, reason = null }) {
  const list = Array.isArray(claims) ? claims : [];
  if (!list.length)
    return { goes: false, by: "rule", asked: 0, design: [], why: "SUE filed no claims, so there is no design trouble to follow up" };
  const asked = list.slice(0, DESIGN_CLAIMS_MAX);
  const design = [];
  let floor = 0;
  for (const c of asked) {
    const p = yesOf(answers?.[`design:${c.id}`]);
    if (p != null) {
      if (p >= DESIGN_BAR) design.push({ id: c.id, text: clip(c.text, 200), p: round2(p), by: "jev" });
    } else {
      floor += 1;
      if (DESIGN_WORDS.test(String(c.text))) design.push({ id: c.id, text: clip(c.text, 200), by: "floor" });
    }
  }
  const goes = design.length >= ART_MIN_DESIGN;
  const judge =
    floor === asked.length
      ? `no Jev (${reason || "no answer"}): the claims' own words decided`
      : floor
        ? `Jev, the floor for the ${floor} it left unanswered`
        : "Jev";
  const over = list.length > asked.length ? `; ${list.length - asked.length} past the first ${DESIGN_CLAIMS_MAX} not asked` : "";
  return {
    goes,
    by: floor === asked.length ? "floor" : "jev",
    asked: asked.length,
    design,
    why: `${design.length} of SUE's ${asked.length} claims read as design trouble (${judge}${over}): ${
      goes
        ? `ART goes${
            design.length
              ? ` (${design
                  .slice(0, 3)
                  .map((d) => d.id)
                  .join(", ")}${design.length > 3 ? ", ..." : ""})`
              : ""
          }`
        : "ART stays home"
    }`,
  };
}

/** The errand a field run carries, checked: the page, why its visitors come, what it is meant to be. Throws a reason. */
export function fieldErrand(args) {
  const url = String(args?.url ?? "").trim();
  const host = hostOfUrl(url);
  if (!/^https?:\/\//i.test(url) || !host) throw new Error("a field run needs the page's web address (url, http or https)");
  const intent = String(args?.intent ?? "").trim();
  if (!intent) throw new Error("a field run needs the errand (intent): why the visitors come");
  return {
    url,
    host,
    intent,
    expect: typeof args?.expect === "string" && args.expect.trim() ? args.expect.trim() : null,
    // The caller's word on accounts rides to every wave: a demo needs none, and then no mailroom is needed either.
    ...(typeof args?.createAccounts === "boolean" ? { createAccounts: args.createAccounts } : {}),
    // So do its word on support (an owned site's default is on, and a Sue who wanders to a Connections page from
    // there reaches our paid support bubble) and on whose site it is.
    ...(typeof args?.contactSupport === "boolean" ? { contactSupport: args.contactSupport } : {}),
    ...(typeof args?.owned === "boolean" ? { owned: args.owned } : {}),
  };
}

/** The people a caller named for SUE's wave, as a list, or null. */
function callerNamed(personas) {
  if (personas == null) return null;
  const ids = (typeof personas === "string" ? personas.split(",") : Array.isArray(personas) ? personas : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  return ids.length ? ids : null;
}

const slimPresue = (r) =>
  r?.ok
    ? {
        said: r.said,
        judge: r.judge,
        fit: r.fit,
        closest: r.closest,
        onboarded: (r.onboarded ?? []).map((v) => v.id),
        ...(r.refused?.length ? { refused: r.refused } : {}),
        ...(r.onboardNote ? { onboardNote: r.onboardNote } : {}),
      }
    : { error: r?.error ?? "pre-sue did not answer" };

/** Pre-sue through its door, never throwing: a report, or `{ ok: false, error }`. */
async function presued(presue, spec) {
  try {
    return await presue(spec);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 300) };
  }
}

/** Jev through its door, never throwing (dredd/lib/jev.mjs askJev's answer shape). */
async function asked(jev, items) {
  if (!jev) return { answers: null, reason: "no Jev in this process" };
  try {
    return (await jev(items)) ?? { answers: null, reason: "no answer" };
  } catch (err) {
    return { answers: null, reason: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * Decide everything a field run can decide before anybody goes: the scope, SUE's visitors, APE (and its visitors).
 * With `sueRun` (a finished SUE run's id), the ART decision is read over that run's claims too, so a dry run shows
 * all four. Returns the record runField carries on; launches nothing, writes nothing.
 */
export async function planField(
  args,
  { jev = null, readPage = null, presue, history = () => [], claimsOf = null, now = () => new Date(), id = null } = {},
) {
  const errand = fieldErrand(args);
  const at = now().toISOString();
  const record = { fieldId: id, at, dryRun: args.dryRun === true, errand, steps: [] };
  const say = (step, said) => record.steps.push({ at: now().toISOString(), step, said });
  let page = null;
  if (readPage)
    try {
      page = await readPage(errand.url);
    } catch (err) {
      page = { error: String(err?.message ?? err).slice(0, 200) };
    }
  const read = page && !page.error ? page : null;
  record.page = read ? { title: read.title ?? null } : { error: page?.error ?? "not read" };
  if (args.sueRun != null && args.dryRun !== true)
    throw new Error("sueRun names an earlier SUE run whose claims a DRY run reads for the ART decision; a field run sends its own SUE");
  const state = presueState({ url: errand.url, page: read, intent: errand.intent, expect: errand.expect });
  const first = await asked(jev, scopeQuestions(state));
  record.scope = decideScope(first.answers, first.reason);
  record.repeatUse = decideRepeat(first.answers, first.reason);
  say(
    "scope",
    record.scope.answer
      ? `scope ${record.scope.answer} (${record.scope.says})${record.scope.p != null ? `, Jev ${record.scope.p}` : ""}`
      : record.scope.note,
  );
  const count = Number.isInteger(args.count) && args.count > 0 ? args.count : FIELD_COUNT;
  const named = callerNamed(args.personas);
  const presueSpec = { url: errand.url, intent: errand.intent, expect: errand.expect, count, scope: record.scope.says, page: read };
  if (named) {
    record.sue = { visitors: named, by: "caller", why: "named by the caller, so pre-sue did not pick" };
  } else {
    const report = await presued(presue, presueSpec);
    const send = report.ok ? report.send.slice(0, count) : [];
    record.sue = {
      visitors: send,
      by: "presue",
      why: report.ok ? report.said : `pre-sue failed: ${report.error}`,
      presue: slimPresue(report),
      ...(report.ok && report.onboarded?.length ? { cast: report.onboarded.filter((v) => send.includes(v.id)) } : {}),
    };
  }
  say("visitors", `SUE sends ${record.sue.visitors.join(", ") || "nobody"} (${record.sue.by}): ${record.sue.why}`);
  record.ape = apeDecision({
    caller: typeof args.ape === "boolean" ? args.ape : null,
    repeat: record.repeatUse,
    history: await history(errand.host),
  });
  if (record.ape.goes) {
    const report = await presued(presue, { ...presueSpec, ape: true });
    record.ape.visitors = report.ok ? report.send.slice(0, count) : [];
    record.ape.presue = slimPresue(report);
    if (report.ok && report.onboarded?.length) record.ape.cast = report.onboarded.filter((v) => record.ape.visitors.includes(v.id));
    if (!record.ape.visitors.length)
      record.ape.why += `; but pre-sue found no power user to send (${report.ok ? report.said : report.error})`;
  }
  say(
    "ape",
    `APE ${record.ape.goes ? `goes (${(record.ape.visitors ?? []).join(", ") || "nobody fit"})` : "stays home"}: ${record.ape.why}`,
  );
  if (args.sueRun && claimsOf) {
    const claims = await claimsOf(String(args.sueRun));
    const judged = claims.length
      ? await asked(
          jev,
          designQuestions(
            claims,
            presueState({ url: errand.url, page: read, intent: errand.intent, expect: errand.expect, scope: record.scope.says }),
          ),
        )
      : { answers: {} };
    record.art = { fromRun: String(args.sueRun), ...artDecision({ claims, answers: judged.answers, reason: judged.reason }) };
    say("art", `ART over run ${args.sueRun}'s claims: ${record.art.why}`);
  } else {
    record.art = { decided: false, why: "decided once SUE's wave has filed her claims" };
  }
  record.state = "planned";
  return record;
}

/**
 * The args one wave is started with (`sue run`): the field's errand, its visitors, never pre-sued again and never handed
 * to the room by itself (`hearing: false`: the field hands every wave in one docket). Headless like every AI-started
 * wave; the brain and the dispatch are the caller's, else the chat brain on CliMayte, sealed (lib/climayte-dispatch.mjs).
 */
export function waveArgs(kind, record, { brain = "chat", dispatch = "climayte", workspace = null } = {}) {
  const { url, intent, expect } = record.errand;
  const base = {
    url,
    intent,
    ...(expect ? { expect } : {}),
    ...(typeof record.errand.createAccounts === "boolean" ? { createAccounts: record.errand.createAccounts } : {}),
    ...(typeof record.errand.contactSupport === "boolean" ? { contactSupport: record.errand.contactSupport } : {}),
    ...(typeof record.errand.owned === "boolean" ? { owned: record.errand.owned } : {}),
    brain,
    ...(dispatch ? { dispatch } : {}),
    hearing: false,
    presue: false,
    ...(workspace ? { workspace } : {}),
  };
  if (kind === "art") return { ...base, art: true };
  const who = kind === "ape" ? record.ape : record.sue;
  return {
    ...base,
    ...(kind === "ape" ? { ape: true } : {}),
    personas: who.visitors,
    count: who.visitors.length,
    ...(who.cast?.length ? { cast: who.cast } : {}),
  };
}

/** The hearing's ask for the whole field, in the room's words. */
export function fieldAsk(record, runs) {
  const who = [...new Set(runs.map((r) => r.kind.toUpperCase()))].join(", ");
  return `${who} filed these problems on ${record.errand.url} in one field run (${record.fieldId}). Rule which are real before anything gets repaired`;
}

/** The record's decisions as lines a person reads (the dry run, `field` status, the docket's FIELD block). Pure. */
export function fieldLines(record) {
  const lines = [
    `Field run ${record.fieldId ?? "(dry run)"} on ${record.errand.url}${record.dryRun ? " - DRY RUN: nobody is launched" : ""}`,
  ];
  const s = record.scope;
  lines.push(`  scope:   ${s.answer ? `${s.answer} - ${s.says}${s.p != null ? ` (Jev ${s.p})` : ""}` : s.note}`);
  const r = record.repeatUse;
  lines.push(
    `  repeat:  ${r.answer ? "visitors come back again and again" : "used once or rarely"}${r.by === "jev" ? ` (Jev ${r.p})` : ` (${r.note})`}`,
  );
  lines.push(
    `  SUE:     ${record.sue.visitors.join(", ") || "nobody"} - ${record.sue.by === "caller" ? record.sue.why : `pre-sue: ${record.sue.why}`}${record.sue.runId ? ` [run ${record.sue.runId}${record.sue.state ? `, ${record.sue.state}` : ""}]` : ""}`,
  );
  const a = record.art;
  lines.push(
    `  ART:     ${a.decided === false ? a.why : `${a.goes ? "runs" : "does not run"} - ${a.why}${a.fromRun ? ` (read over run ${a.fromRun})` : ""}`}${a.runId ? ` [run ${a.runId}${a.state ? `, ${a.state}` : ""}]` : ""}`,
  );
  const p = record.ape;
  lines.push(
    `  APE:     ${p.goes ? `runs (${(p.visitors ?? []).join(", ") || "nobody fit"})` : "does not run"} - ${p.why}${p.runId ? ` [run ${p.runId}${p.state ? `, ${p.state}` : ""}]` : ""}`,
  );
  const room = record.room;
  if (room)
    lines.push(
      `  room:    ${room.open ? "a meeting opened" : "stayed closed"} after ${room.probes} probe(s), ${Math.round(room.waitedMs / 60_000)} minute(s) waited${room.firstRefusal ? ` (first refused: ${room.firstRefusal})` : ""}${room.probeError ? ` (the probe failed, handed anyway: ${room.probeError})` : ""}`,
    );
  if (record.docket)
    lines.push(
      `  docket:  ${record.docket.dir ?? `not handed: ${record.docket.error}`}${record.docket.runs ? ` (${record.docket.runs.map((x) => `${x.kind}:${x.runId}`).join(", ")})` : ""}`,
    );
  else if (record.dryRun)
    lines.push(
      "  docket:  one docket for every finished wave, handed to the room once (dredd.mjs --run <kind>:<id>,... --hearing --detach --field)",
    );
  return lines;
}

const FINISHED = /^finished/;

/** How often a closed room is asked again, and how long a field waits on it before keeping its waves unhanded. */
export const ROOM_PROBE_EVERY_MS = 10 * 60_000;
export const ROOM_WAIT_MAX_MS = 6 * 60 * 60_000;

/**
 * Wait until one cheap meeting opens: `probe()` answers `{ open }`, `{ refused, why }` (the allowance or credit) or
 * `{ error }`. Only a refusal holds the hand; a probe that fails some other way hands anyway, said. Answers
 * `{ open, probes, waitedMs, firstRefusal?, refusal?, probeError? }`.
 */
export async function waitForRoom({
  probe,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  everyMs = ROOM_PROBE_EVERY_MS,
  maxMs = ROOM_WAIT_MAX_MS,
  onWait = () => {},
}) {
  const t0 = now();
  let probes = 0;
  let firstRefusal = null;
  for (;;) {
    let r;
    try {
      r = await probe();
    } catch (err) {
      r = { error: String(err?.message ?? err).slice(0, 200) };
    }
    probes += 1;
    const waitedMs = now() - t0;
    const seen = firstRefusal ? { firstRefusal } : {};
    if (r?.open) return { open: true, probes, waitedMs, ...seen };
    if (!r?.refused) return { open: true, probes, waitedMs, ...seen, probeError: r?.error ?? "no answer" };
    firstRefusal ??= r.why;
    if (waitedMs >= maxMs) return { open: false, probes, waitedMs, firstRefusal, refusal: r.why };
    await onWait(r);
    await sleep(everyMs);
  }
}

/** One wave started and waited on, its outcome written onto `slot` (record.sue, record.art or record.ape). */
async function runWave(kind, slot, record, doors, opts) {
  if (slot.runId && slot.state && !/^(starting|running)$/.test(slot.state)) return;
  if (!slot.runId) {
    let started;
    try {
      started = await doors.startWave(waveArgs(kind, record, opts));
    } catch (err) {
      started = { error: String(err?.message ?? err).slice(0, 300) };
    }
    if (!started?.runId) {
      slot.state = "not started";
      slot.error = started?.error ?? "the wave answered no run id";
      record.steps.push({ at: new Date().toISOString(), step: kind, said: `${kind.toUpperCase()} did not start: ${slot.error}` });
      await doors.save(record);
      return;
    }
    slot.runId = started.runId;
    slot.state = "running";
    record.steps.push({ at: new Date().toISOString(), step: kind, said: `${kind.toUpperCase()} run ${slot.runId} started` });
    await doors.save(record);
  }
  const ended = await doors.waitWave(slot.runId);
  slot.state = ended?.state ?? "unknown";
  if (ended?.why?.length) slot.endedWhy = ended.why;
  record.steps.push({ at: new Date().toISOString(), step: kind, said: `${kind.toUpperCase()} run ${slot.runId} ended ${slot.state}` });
  await doors.save(record);
}

/**
 * Carry a planned field run to its docket: SUE's wave, the ART decision over her claims, ART and APE together, then
 * every finished wave handed to the room in one docket. Resumable from any step: a slot whose run has ended is not run
 * again, a decided ART is not re-asked, a handed docket is not handed twice. `save(record)` after every step.
 */
export async function runField(record, doors, opts = {}) {
  const { claimsOf, jev = null, hand, appendLedger = async () => {} } = doors;
  record.state = "sue";
  await doors.save(record);
  if (record.sue.visitors.length) await runWave("sue", record.sue, record, doors, opts);
  else {
    record.sue.state = "not started";
    record.sue.error = "nobody to send";
  }
  if (record.art.decided === false) {
    if (!FINISHED.test(record.sue.state ?? "")) {
      record.art = {
        goes: false,
        by: "rule",
        asked: 0,
        design: [],
        why: `SUE's wave ended ${record.sue.state}, so there are no claims to read`,
      };
    } else {
      const claims = await claimsOf(record.sue.runId);
      const state = presueState({
        url: record.errand.url,
        intent: record.errand.intent,
        expect: record.errand.expect,
        scope: record.scope.says,
      });
      const judged = claims.length ? await asked(jev, designQuestions(claims, state)) : { answers: {} };
      record.art = artDecision({ claims, answers: judged.answers, reason: judged.reason });
      record.sue.claims = claims.length;
    }
    record.steps.push({
      at: new Date().toISOString(),
      step: "art",
      said: `ART ${record.art.goes ? "goes" : "stays home"}: ${record.art.why}`,
    });
    await doors.save(record);
  }
  record.state = "art-ape";
  const after = [];
  if (record.art.goes) after.push(runWave("art", record.art, record, doors, opts));
  if (record.ape.goes && record.ape.visitors?.length) after.push(runWave("ape", record.ape, record, doors, opts));
  await Promise.all(after);
  const runs = [
    ["sue", record.sue],
    ["art", record.art],
    ["ape", record.ape],
  ]
    .filter(([, slot]) => slot.runId && FINISHED.test(slot.state ?? ""))
    .map(([kind, slot]) => ({ kind, runId: slot.runId }));
  if (!record.docket?.dir) {
    if (!runs.length) record.docket = { error: "no wave finished, so there is nothing to hand to the room", runs };
    else {
      record.state = "handing";
      await doors.save(record);
      // A room that refuses (its allowance spent) would still file a verdict with no rulings in it: hand only once a
      // meeting opens, and keep the waves when it never does.
      if (doors.probeRoom) {
        record.room = await waitForRoom({ probe: doors.probeRoom, sleep: doors.sleep, onWait: () => doors.save(record) });
        await doors.save(record);
      }
      if (record.room && !record.room.open)
        record.docket = {
          error: `the Boardroom refused for ${Math.round(record.room.waitedMs / 60_000)} minutes (${record.room.refusal}); the waves are kept, run this field again (sue.mjs _field --spec <its field.json>) to hand them`,
          runs,
        };
      else {
        const handed = await hand({ record, runs, ask: fieldAsk(record, runs) });
        record.docket = handed?.docket
          ? { dir: handed.docket, at: handed.at ?? new Date().toISOString(), runs }
          : { error: handed?.error ?? "the room did not answer", runs };
      }
    }
    record.steps.push({
      at: new Date().toISOString(),
      step: "docket",
      said: record.docket.dir ? `one docket for ${runs.length} wave(s): ${record.docket.dir}` : `no docket: ${record.docket.error}`,
    });
  }
  record.state = record.docket.dir ? "handed" : "ended";
  record.endedAt = new Date().toISOString();
  await doors.save(record);
  if (!record.ledgered && runs.length) {
    await appendLedger({
      fieldId: record.fieldId,
      host: record.errand.host,
      at: record.at,
      ape: runs.some((r) => r.kind === "ape"),
      art: runs.some((r) => r.kind === "art"),
      scope: record.scope.answer,
    });
    record.ledgered = true;
    await doors.save(record);
  }
  return record;
}

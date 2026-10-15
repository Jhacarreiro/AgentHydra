// dredd/lib/ladder.mjs - the page ladder, and the code-or-opinion split.
//
// the Chair's five questions about a page, in the order he asked them (2026-09-22): is the page broken?
// does the design look good? does it make sense? can people understand it? is the copy up to snuff?
// Each rung names the instrument that answers it and reads that instrument's evidence out of the docket.
// A broken page stops the ladder at rung one - there is no point critiquing the design of a page that
// does not load - and the room sits over the breakage instead. Pure: nothing here spawns or reads disk.
//
// The other law from the same message: "the architect is the architect - code is fucked, fix the code
// ... when it comes to things that are not specifically code-related, run through Jev." So every docket
// is a CODE matter (the Architect's checks are facts; fix what they name) or an OPINION matter (Jev
// picks the bench and the seats; the visitors' words and the room's verdict decide).

import { renderVision } from "./vision.mjs";

export const RUNGS = [
  { n: 1, id: "broken", question: "Is the page broken?", instruments: ["page-pulse"] },
  { n: 2, id: "looks", question: "Does the design look good?", instruments: ["design-critic"] },
  { n: 3, id: "sense", question: "Does the design make sense?", instruments: ["lilgranny"] },
  { n: 4, id: "understood", question: "Can people understand it?", instruments: ["sue"] },
  { n: 5, id: "copy", question: "Is the copy up to snuff?", instruments: ["copy-audit", "humanizer"] },
];

// Money is a code matter: the bill is a fact a script reads off Cost Explorer, not an opinion to argue (2026-09-23).
export const CODE_DOMAINS = ["code", "data", "infra", "security", "money"];

export function matterFor(domain) {
  return CODE_DOMAINS.includes(domain)
    ? {
        kind: "code",
        why: "the Architect rules - a check's finding is a fact to fix, not an opinion to argue; the room sits only when asked",
      }
    : {
        kind: "opinion",
        why: "Jev picks the bench and the seats; the visitors' words and the room's verdict decide, never a check's exit code",
      };
}

const exitOf = (log) => {
  const m = /--- exit (-?\d+)/.exec(log || "");
  return m ? Number(m[1]) : null;
};

const UNMEASURED = new Set(["no-data", "crashed", "skipped"]);

/**
 * One Architect run's verdict, read from the manifest it wrote into the docket (`--out`), never from its exit code: a
 * run that does not enforce exits 0 over any finding, so rungs three and five read "pass" over warnings, no-data and a
 * crashed check alike (the Opus 5.5 instrument review, 2026-09-22). `ids` narrows to named checks; left out, every row
 * the run wrote counts. Returns { state: pass | wobbly | fail | skipped, evidence }. Pure.
 */
export function checksVerdict(manifest, { ids = null, label = "the checks" } = {}) {
  const all = Array.isArray(manifest?.checks) ? manifest.checks : [];
  const rows = ids ? ids.map((id) => all.find((c) => c.id === id) || { id, status: "absent" }) : all;
  const gone = rows.filter((r) => UNMEASURED.has(r.status) || r.status === "absent");
  const measured = rows.filter((r) => !gone.includes(r));
  const notMeasured = gone.length ? `; not measured: ${gone.map((r) => `${r.id} (${r.status})`).join(", ")}` : "";
  if (!measured.length) return { state: "skipped", evidence: `${label}: nothing measured${notMeasured || " (no checks in the run)"}` };
  const errors = measured.reduce((n, r) => n + (Number(r.errors) || 0), 0);
  const warnings = measured.reduce((n, r) => n + (Number(r.warnings) || 0), 0);
  const failed = measured.some((r) => r.status === "failed" || Number(r.errors) > 0);
  const state = failed ? "fail" : warnings > 0 || measured.some((r) => r.status === "warned") ? "wobbly" : "pass";
  return { state, evidence: `${label}: ${errors} error(s), ${warnings} warning(s) over ${measured.length} check(s)${notMeasured}` };
}

/** An ask about LENGTH. No rule decides length (the Chair, 2026-09-15: verbosity has no magic number), so a copy rung the
 *  rules pass is the room's to judge on such an ask, with the visible word count as its evidence. */
const LENGTH_ASK_RX = /\b(?:bloated|verbose|wordy|too (?:long|much text|many words)|wall of text|long-winded|brochure)\b/i;

/**
 * Each rung's state from what the docket holds - pass | fail | wobbly | yours | pending | skipped |
 * not-convened - with one line of evidence. `logs` maps an instrument id to its log text; `pulse` is
 * page-pulse.json; `sue` is SUE's report; `manifests` maps "lilgranny" and "copy-audit" to the Architect
 * manifest each run wrote into the docket.
 */
export function ladderState({ docket, results = [], logs = {}, pulse = null, sue = null, manifests = {} }) {
  return markNotChecked(ladderRungs({ docket, results, logs, pulse, sue, manifests }), docket, results);
}

/** The states a rung ends a hearing in when nothing answered it: dark, skipped, or still out when the room sat. */
const DID_NOT_RUN = new Set(["not-convened", "skipped", "pending"]);

/**
 * On a page hearing (a URL named), every rung that did not run is marked `notChecked`, with the reason on its evidence
 * - the reason the convene or the collector gave, or, when none did, that the instrument is off this repository's bench
 * (docket.bench.filtered) or was not convened. A quiet "-" beside a board score read as a pass: twelve hearings passed a
 * site on its copy alone, with rungs two to four dark (2026-09-24). A code matter's dark rungs stay quiet. Pure.
 */
export function markNotChecked(rungs, docket, results = []) {
  if (!docket?.url) return rungs;
  const filtered = new Map((docket.bench?.filtered || []).map((f) => [f.id, f.why]));
  for (const r of rungs) {
    if (!DID_NOT_RUN.has(r.state)) continue;
    r.notChecked = true;
    if (r.state === "pending") r.evidence = `still out when the room sat${r.evidence ? `: ${r.evidence}` : ""}`;
    if (r.evidence) continue;
    const off = r.instruments.filter((id) => filtered.has(id));
    const ran = r.instruments.some((id) => results.some((x) => x.id === id));
    r.evidence = off.length
      ? `${off.map((id) => `${id} is off this repository's bench (${filtered.get(id)})`).join("; ")}`
      : ran
        ? "it ran and left nothing to read"
        : `${r.instruments.join(" and ")} was not convened for this ask`;
  }
  return rungs;
}

function ladderRungs({ docket, results = [], logs = {}, pulse = null, sue = null, manifests = {} }) {
  const convened = new Set([...(docket.convene || []).map((c) => c.id), ...results.map((r) => r.id)]);
  const result = (id) => results.find((r) => r.id === id);
  const rungs = RUNGS.map((r) => ({ ...r, state: "not-convened", evidence: "" }));
  const [broken, looks, sense, understood, copy] = rungs;

  if (pulse) {
    // "unmeasured": the page answered but its facts could not be read (page-pulse names the cause). Not a pass and not
    // a break - the rung says it could not tell, and the ladder goes on (the Opus 5.5 review, 2026-09-22).
    broken.state =
      pulse.verdict === "broken" ? "fail" : pulse.verdict === "wobbly" ? "wobbly" : pulse.verdict === "unmeasured" ? "skipped" : "pass";
    broken.evidence = pulse.summary || "";
  } else if (convened.has("page-pulse")) {
    broken.state = "pending";
    broken.evidence = result("page-pulse")?.status || "";
  }
  if (broken.state === "fail") {
    for (const r of [looks, sense, understood, copy]) {
      r.state = "skipped";
      r.evidence = "the page is broken - fix that first";
    }
    return rungs;
  }

  if (convened.has("design-critic")) {
    const dc = result("design-critic");
    if (dc && dc.status === "skipped") {
      // The convene skipped it (no page named): the rung is dark, and the note says why - never "the wave has not
      // landed", which reads as a wait that would end. (A docket from before 2026-09-24 also skipped an off-roster host.)
      looks.state = "not-convened";
      looks.evidence = dc.note || "skipped";
    } else if (dc?.pageShots) {
      // A page the lane cannot photograph: page-pulse's own photographs, scored by the vision model at collect. A score
      // rides labelled, the rung stays yours; a score that did not come is dark with the collector's loud reason.
      if (dc.vision && typeof dc.vision.overall === "number") {
        // The number is the weakest slice's; the three lowest are named with their issues, since that is where to look.
        const lowest = (dc.vision.lowest || []).map(
          (s) => `${s.overall}/10 ${s.id}${s.issues?.length ? ` (${s.issues.slice(0, 2).join("; ")})` : ""}`,
        );
        looks.state = "yours";
        // A page longer than the slices reach says what was left unscored, loudly, on the rung itself.
        const left = (dc.vision.unscored || []).map((n) => ` · NOT SCORED: ${n}`).join("");
        looks.evidence = `${renderVision(dc.vision)} · from page-pulse's viewport slices${lowest.length ? ` · lowest: ${lowest.join(" · ")}` : ""}${left}`;
      } else if (/^NOT SCORED/.test(String(dc.status || ""))) {
        looks.state = "not-convened";
        looks.evidence = String(dc.status).replace(/^NOT SCORED:\s*/, "the photographs were not scored: ");
      } else {
        looks.state = "pending";
        looks.evidence = "page-pulse's photographs are scored at --collect";
      }
    } else if (dc && /collected/.test(dc.status)) {
      // The rung stays yours whatever a vision model said: its number rides in the evidence, labelled, beside the
      // session's own duty to score (lib/vision.mjs, D39). The ceiling in lib/ballot.mjs reads states, never this.
      looks.state = "yours";
      looks.evidence = dc.vision && typeof dc.vision.overall === "number" ? `${renderVision(dc.vision)} · ${dc.status}` : dc.status;
    } else {
      looks.state = "pending";
      looks.evidence = dc?.status || "the wave has not landed";
    }
  }
  if (convened.has("lilgranny") || logs.lilgranny) {
    const code = exitOf(logs.lilgranny);
    const notRun = /^not run:.*$/m.exec(String(logs.lilgranny || ""));
    const lg = result("lilgranny");
    if (!logs.lilgranny && lg && (lg.status === "skipped" || lg.status === "deferred")) {
      // The convene held her back (lib/convene.mjs lilgrannyAtConvene): an off-roster page has nothing for her to
      // grade (dark, with the reason), a docket whose critic is shooting waits for that capture (pending, said so).
      sense.state = lg.status === "skipped" ? "not-convened" : "pending";
      sense.evidence = lg.note || lg.status;
    } else if (notRun) {
      // The collector says why it did not run (an ad hoc page: LilGranny reads the roster capture) - not a pass.
      sense.state = "not-convened";
      sense.evidence = notRun[0];
    } else if (manifests.lilgranny) {
      // Her findings carry no surface yet, so the count is over the whole roster capture and says so. Over an off-roster
      // page (page-pulse's scan, convene.mjs lilgrannyOverPulse) the report names its own label and its findings by rule.
      const report = manifests.lilgranny;
      const v = checksVerdict(report, { ids: ["design-critic-granny"], label: report.label || "LilGranny over the roster capture" });
      sense.state = v.state;
      sense.evidence =
        v.state === "pass" ? "LilGranny found nothing a first-timer would trip on" : `${v.evidence}${report.top ? ` · ${report.top}` : ""}`;
    } else if (code === null) {
      sense.state = "pending";
      sense.evidence = "no granny log yet";
    } else {
      // A log with no manifest beside it (a docket from before the manifest was written) says only an exit code, and
      // her exit is 0 over any finding: not measured, never a pass.
      sense.state = "skipped";
      sense.evidence = `LilGranny exit ${code} with no report to read - see lilgranny.log`;
    }
  }
  const sueRow = result("sue");
  if (!sue && sueRow && /^refused/.test(String(sueRow.status || ""))) {
    // The cannon refused (no brain, no mailroom): rung four is dark with the reason, never a wait that would end.
    understood.state = "not-convened";
    understood.evidence = sueRow.note || sueRow.status;
  } else if (sue) {
    const v = sue.verdict || {};
    const n = Number(sue.sues) || 0;
    const noIdea = Number((sue.understoodIt || {})["no-idea"]) || 0;
    const ungraded = Number((sue.understoodIt || {}).ungraded) || 0;
    const stars = typeof v.averageStars === "number" ? v.averageStars : null;
    const ok = stars !== null && stars >= 3.5 && (n === 0 || noIdea / n < 0.5);
    understood.state = ok ? "pass" : "fail";
    const grasp = ungraded ? "what it is: not graded (the page's SUE target has no ground truth)" : `${noIdea} of ${n} had no idea what it is`;
    understood.evidence = `${stars ?? "-"} stars over ${n} Sue(s); ${grasp}; never coming back: ${Math.round((v.neverComingBackShare || 0) * 100)}%`;
  } else if (convened.has("sue")) {
    understood.state = "pending";
    understood.evidence = result("sue")?.status || "";
  }
  if (convened.has("copy-audit") || logs["copy-audit"] || pulse?.copy) {
    // Two halves: the page's own visible copy (page-pulse's copy block, from the same load as rung one) and the
    // repository's copy checks (their manifest). A half that was not measured says so; neither ever passes by default.
    const parts = [];
    if (pulse?.copy) {
      const v = pulse.copy.verdict;
      parts.push({ state: v === "unmeasured" ? "skipped" : v, evidence: `the page: ${pulse.copy.summary}` });
    }
    const ca = result("copy-audit");
    if (ca && ca.status === "skipped") parts.push({ state: "skipped", evidence: ca.note || "the copy checks were skipped" });
    else if (manifests["copy-audit"]) parts.push(checksVerdict(manifests["copy-audit"], { label: "the copy checks" }));
    else if (logs["copy-audit"]) parts.push({ state: "skipped", evidence: "the copy checks left no report to read - see copy-audit.log" });
    if (!parts.length) {
      copy.state = "pending";
      copy.evidence = "";
    } else {
      const has = (s) => parts.some((p) => p.state === s);
      copy.state = has("fail") ? "fail" : parts.every((p) => p.state === "skipped") ? "skipped" : has("wobbly") ? "wobbly" : "pass";
      copy.evidence = parts.map((p) => p.evidence).join("; ");
      if (copy.state !== "fail" && copy.state !== "skipped" && LENGTH_ASK_RX.test(String(docket.ask || ""))) {
        copy.state = "yours";
        copy.evidence += "; length itself is the room's call - no rule decides it";
      }
    }
  }
  return rungs;
}

const MARK = { pass: "ok", fail: "FAIL", wobbly: "wob", yours: "you", pending: "wait", skipped: "skip", "not-convened": "-" };

/** What each rung's number is a verdict on, for the line that says what the board's score covers. */
const RUNG_SUBJECT = {
  broken: "whether it loads",
  looks: "the design",
  sense: "whether the design makes sense",
  understood: "whether people understand it",
  copy: "the copy",
};

const listed = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The line under a page ladder with any rung NOT CHECKED, pure: what the board's score covers, and what it is no verdict
 * on. "" when every rung ran. A board score printed under a ladder of quiet dashes read as the page passing.
 */
export function scoreCovers(rungs) {
  const dark = (rungs || []).filter((r) => r.notChecked);
  if (!dark.length) return "";
  const checked = rungs.filter((r) => !r.notChecked);
  const subject = (r) => RUNG_SUBJECT[r.id] || r.question;
  const covers = checked.length
    ? `THE SCORE COVERS ${listed(checked.map(subject))} ONLY (rung${checked.length > 1 ? "s" : ""} ${listed(checked.map((r) => String(r.n)))})`
    : "THE SCORE COVERS NO RUNG OF THE LADDER";
  return `${covers}: ${listed(dark.map(subject))} ${dark.length === 1 ? "was" : "were"} NOT CHECKED, and the board's number is no verdict on ${dark.length === 1 ? "it" : "them"}.`;
}

export function renderLadder(rungs) {
  const lines = rungs.map((r) =>
    r.notChecked
      ? `  ${r.n}. NOT CHECKED: ${r.question} - ${r.evidence || "nothing ran for it"}`
      : `  ${r.n}. ${(MARK[r.state] || r.state).padEnd(4)} ${r.question.padEnd(30)} ${r.evidence || ""}`.trimEnd(),
  );
  const covers = scoreCovers(rungs);
  return covers ? [...lines, `  ${covers}`] : lines;
}

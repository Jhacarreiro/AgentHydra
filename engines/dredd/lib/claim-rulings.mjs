import { targetRoot } from "../../lib/target.mjs";
// dredd/lib/claim-rulings.mjs - the field's claims, ruled by the room before any repair (SUE, APE and ART only find errors).
// Claims go to the Connections Boardroom in batches (rule-claims.mjs); a room that cannot be reached throws.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODE_DOMAINS } from "./ladder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The bun script that holds one batch's sitting on the Connections Boardroom (dredd/rule-claims.mjs). */
export const RULE_SCRIPT = path.join(HERE, "..", "rule-claims.mjs");
/** The checkout whose sue/runs/ holds the finished runs (adoptRuns reads the same folder). */
const CHECKOUT = targetRoot();

/** The characters of claim text one sitting carries: the plane's prompt cap (48k) holds it with the room's own lines. */
export const BATCH_MAX_CHARS = 6000;
/**
 * Sittings held at once after the first. Every claim a run's notes hold is ruled (about 150 over Packing Buddy's five
 * runs), and one sitting takes a minute or two, so one at a time ran past half an hour.
 */
export const SITTINGS_AT_ONCE = 3;

/**
 * The one instruction every seat reads under the claims: the reply shape the parser below reads, nothing else. It opens
 * the sitting's round, and "each of you, independently" makes the plane run it as a blind panel (boardroom-contract.ts
 * wantsBlindPanel): no seat's prompt holds another's ruling. Heard in order, the seats copied the first: the 2026-10-10
 * calibration ruled 40 of 40 claims unanimously, 0 of 156 later votes breaking from the first speaker.
 */
export const RULING_INSTRUCTION = [
  "RULING. Each numbered claim below was reported by a visitor, a focus group or the design review. Each of you, independently, rule on each one:",
  "is it REAL (the evidence shows the problem is there), NOT REAL (the evidence shows it is not, or the visitor misread the page),",
  "or CAN'T TELL (the evidence does not settle it).",
  "Under a claim is the visitor's own record when the run kept one: their note, what they expected and what they got,",
  "their steps, what the page answered to their last moves and the page as they last looked at it. A claim marked",
  '"her screen: picture N" comes with the picture she took then (the pictures are in that order): look at it. Judge from that record.',
  "Answer with one line per claim and nothing else, exactly in this shape:",
  "C1: REAL - one line of why",
  "C2: NOT REAL - one line of why",
  "C3: CAN'T TELL - one line of why",
  "Answer every claim id given.",
].join("\n");

const RULINGS = { real: "REAL", notReal: "NOT REAL", cantTell: "CAN'T TELL" };

/**
 * The line ART's fix-first items print as. ART's own claims were never instructions; they are claimed until the room
 * rules on them (lib/collect.mjs artLines).
 */
export const CLAIMED_FIX_FIRST = "claimed fix first (the room has not ruled):";

/**
 * The room that rules on the field's claims, whatever the hearing's question seated (the owner, 2026-10-09: "the
 * boardroom is packed with the world's smartest experts that make these decisions"): the design critic for how it
 * looks, the product engineer for whether it is broken, the adversary to say when a visitor misread the page, Grandma
 * Sue for whether a person would trip on it, and the Chair, whose call UI is. Named in priority order: the plane seats five.
 */
export const RULING_PANEL = Object.freeze(["design-critic", "product-engineer", "the-adversary", "grandma-sue", "chair"]);

/**
 * The seats that rule: the panel members this roster has, then the hearing's own picks, five at most (the plane's cap).
 * A repository judged with its own seats (`--root`, its .dredd/seats/) may lack a panel seat; its picks fill the chair.
 * `rosterIds` is every seat id the roster holds. Pure.
 */
export function rulingSeats(picked = [], rosterIds = RULING_PANEL, cap = 5) {
  const have = new Set(rosterIds);
  const panel = RULING_PANEL.filter((id) => have.has(id));
  return [...new Set([...panel, ...picked.map((s) => s.id ?? s)])].slice(0, cap);
}

const FILED = /^Problems the visitors filed/;
const literal = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/**
 * The field's three logs and what each section of them is. A section's items are the lines under its header; `named`
 * says where an item names its screen: "on /x" in a filed problem, the part before ": " in an ART design line. ART's
 * "start here, by design debt" lines are scores per screen, not claims of a defect, so they are not read.
 */
const SECTIONS = [
  { log: "sue.log", who: "SUE", header: FILED, named: "on" },
  { log: "ape.log", who: "APE", header: FILED, named: "on" },
  { log: "art.log", who: "ART", header: literal(CLAIMED_FIX_FIRST), named: "colon" },
  { log: "art.log", who: "ART", header: FILED, named: "on" },
];

/** Lower-cased words, punctuation and spacing gone: the key two claims are compared by. */
const normalize = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (text) => new Set(normalize(text).split(" ").filter(Boolean));

/** Word overlap of two claims, 0 to 1 (the same thing said twice scores near 1). */
export function similarity(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** A near-identical claim is the same claim said again (two visitors, one bug). */
const SAME_CLAIM = 0.8;

/** The screen a claim names: "/checkout" in a problem's "on /checkout", the part before ": " in an ART design line. */
function screenOf(text, named) {
  if (named === "colon") return /^([^:\s]+):/.exec(text)?.[1]?.trim() ?? null;
  return /\bon (\/\S*|https?:\/\/\S+)/.exec(text)?.[1] ?? null;
}

/** The line that opens one run's part of a log: "SUE run <id>", "APE run <id>", "ART run <id>". */
const RUN_LINE = /^(?:SUE|APE|ART|Focus group) run (\S+)/;

/**
 * The claims one log's text holds, in order. A log may hold several runs, each under its own "<TITLE> run <id>" line
 * (a docket that adopted them, lib/collect.mjs), so every section of every run is read, each claim carrying its run.
 * A claim is a top-level "- " line under the section's header; its indented lines (the expected and the actual of a
 * repro, the steps) are part of it. Pure.
 */
export function claimsOfLog(text, { log, who, header, named = "on" }) {
  const out = [];
  let run = null;
  let inSection = false;
  let last = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const opened = RUN_LINE.exec(line);
    if (opened) {
      run = opened[1];
      inSection = false;
      continue;
    }
    if (header.test(line.trim())) {
      inSection = true;
      last = null;
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("- ")) {
      const body = line.slice(2).trim();
      last = { text: body, who, run, log, screen: screenOf(body, named), words: [] };
      out.push(last);
    } else if (/^\s{2,}\S/.test(line) && last) {
      last.words.push(line.trim());
    } else if (line.trim()) inSection = false;
  }
  return out;
}

/**
 * Every claim the field's logs hold, the same thing said twice merged into one (its sources listed). Each claim's id is
 * C<n> in order, the id the room answers by. `logs` is { "sue.log": text, ... } (missing logs are simply empty). With
 * `runsRoot` (the checkout whose sue/runs/ holds the runs) each source carries the visitor's own record
 * (evidenceOf). Pure over that folder.
 */
export function fieldClaims(logs = {}, { runsRoot = null } = {}) {
  const found = [];
  for (const sec of SECTIONS) found.push(...claimsOfLog(logs[sec.log] ?? "", sec));
  // The notes a log line already speaks for, so a run's own notes (below) add only the ones no line carried.
  const spoken = new Set();
  for (const c of found) {
    const hit = runsRoot ? noteOf(runsRoot, c.run, c.text) : null;
    const rec = hit ? recordOf(hit) : { lines: [], shot: null };
    c.evidence = rec.lines;
    c.shot = rec.shot;
    if (hit) spoken.add(noteKey(hit));
  }
  if (runsRoot) found.push(...notedClaims(runsRoot, runsOfLogs(logs), spoken));
  const merged = [];
  for (const c of found) {
    const twin = merged.find((m) => normalize(m.text) === normalize(c.text) || similarity(m.text, c.text) >= SAME_CLAIM);
    const source = { who: c.who, run: c.run, screen: c.screen, words: c.words, evidence: c.evidence, shot: c.shot ?? null };
    if (twin) twin.sources.push(source);
    else merged.push({ text: c.text, screen: c.screen, sources: [source] });
  }
  return merged.map((c, i) => ({ id: `C${i + 1}`, ...c }));
}

/** Which tool a log's runs are: the "<TITLE> run <id>" lines of sue.log, ape.log and art.log. */
const LOG_WHO = { "sue.log": "SUE", "ape.log": "APE", "art.log": "ART" };

/** Every run the logs open, with the tool that ran it, in order: [{ run, who }]. Pure. */
function runsOfLogs(logs) {
  const out = [];
  for (const [log, who] of Object.entries(LOG_WHO))
    for (const line of String(logs[log] ?? "").split(/\r?\n/)) {
      const run = RUN_LINE.exec(line)?.[1];
      if (run && !out.some((r) => r.run === run)) out.push({ run, who });
    }
  return out;
}

/**
 * The kinds of note that say something is wrong with the page, each a claim the room rules on (the owner, 2026-10-09:
 * every finding goes through the Boardroom). A designer's polish line, a visitor's confusion, annoyance, broken or drop,
 * and what SUE's body measured on her behalf (a dead end, a missed thumb, text too small, a slow answer, the keyboard in
 * the way, an error the page threw or a request it got refused). Praise (keep, delight, hook), thoughts, questions and
 * the visit's own bookkeeping (done, turns-nearly-out, bored, gave-up) are not claims of a defect.
 */
export const CLAIM_NOTE_KINDS = Object.freeze([
  "polish",
  "confusion",
  "annoyance",
  "broken",
  "drop",
  "dead-end",
  "thumb-miss",
  "tiny-text",
  "slow-response",
  "keyboard-in-the-way",
  "console-error",
  "http-error",
]);

/**
 * The page's own errors, which repeat: one tap on Raise Buddy's apply form threw the same TypeError 25 times in 200 ms
 * (2026-10-11), and before these kinds were claims, 25 console errors and 8 refused requests never reached the room. A
 * visitor's same error is one claim source, however often it fired.
 */
const ONCE_PER_VISITOR = new Set(["console-error", "http-error"]);

const noteKey = ({ dir, sueId, note }) => `${dir}|${sueId}|${note.at}|${note.text}`;

/** A note's page as a claim names it: the path and query of its URL ("/print", "/?demo"). */
function screenOfUrl(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Every note of the runs' visitors that claims a defect (CLAIM_NOTE_KINDS) and that no log line already carried
 * (`spoken`). A hearing's log keeps a report's head only (ART's runs to 58k characters, the log to 12k), so a
 * designer's polish lines were never ruled on, and Packing Buddy shipped four of them unruled (2026-10-10). Read from
 * the run's own folder, each with its record. Pure over the folder.
 */
function notedClaims(runsRoot, runs, spoken) {
  const out = [];
  for (const { run, who } of runs) {
    const dir = runDirOf(runsRoot, run);
    if (!existsSync(dir)) continue;
    for (const sueId of readdirSync(dir).filter((d) => d.startsWith("sue-")).sort()) {
      for (const note of readJsonl(path.join(dir, sueId, "findings.jsonl"))) {
        const hit = { dir, sueId, note };
        if (!CLAIM_NOTE_KINDS.includes(note.kind) || !String(note.text ?? "").trim() || spoken.has(noteKey(hit))) continue;
        const repeat = `${dir}|${sueId}|${note.kind}|${note.text}`;
        if (ONCE_PER_VISITOR.has(note.kind) && spoken.has(repeat)) continue;
        spoken.add(noteKey(hit));
        if (ONCE_PER_VISITOR.has(note.kind)) spoken.add(repeat);
        const severity = Number.isInteger(note.severity) ? ` ${note.severity}` : "";
        const rec = recordOf(hit);
        out.push({
          text: `${note.kind}${severity}: ${clip(note.text, 400)}`,
          who,
          run,
          log: "notes",
          screen: screenOfUrl(note.url),
          words: [],
          evidence: rec.lines,
          shot: rec.shot,
        });
      }
    }
  }
  return out;
}

const clip = (text, max) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
};

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a torn last line (the visitor's process ended mid-write) is not a record
    }
  }
  return rows;
}

/** A filed problem's ref in a claim's text: "(sue-4130-homeowner-hannah:6)", or "(sue-4131-...:6, her look: <png>)". */
const FILED_REF = /\((sue-[\w-]+):(\d+)[,)]/;
/** How alike a design line and a visitor's note must be to be the same observation (ART's lines carry no ref). */
const SAME_NOTE = 0.35;

/**
 * The visitor's own record behind one claim, read from its run's folder: their note, what they expected and what they
 * got, their steps, and what the page answered to their last moves before they wrote it. A filed problem is found by
 * its ref; an ART design line, which carries none, by the most alike note in the run. The room asked for exactly this
 * on the first Packing Buddy ruling (2026-10-10): 14 of 15 claims came back CAN'T TELL, "no before and after evidence".
 * Lines of text, empty when the run kept nothing. Pure over the folder.
 */
export function evidenceOf(runsRoot, run, text) {
  const hit = noteOf(runsRoot, run, text);
  return hit ? recordOf(hit).lines : [];
}

/** The note behind one claim line, found as evidenceOf says: { dir, sueId, note }, or null. Pure over the folder. */
function noteOf(runsRoot, run, text) {
  if (!runsRoot || !run) return null;
  const dir = runDirOf(runsRoot, run);
  if (!existsSync(dir)) return null;
  const ref = FILED_REF.exec(text);
  const sues = ref ? [ref[1]] : readdirSync(dir).filter((d) => d.startsWith("sue-"));
  let best = null;
  for (const sueId of sues) {
    for (const note of readJsonl(path.join(dir, sueId, "findings.jsonl"))) {
      const score = ref ? (note.problem?.ref === `${ref[1]}:${ref[2]}` ? 1 : 0) : similarity(note.text, text);
      if (score > (best?.score ?? 0) && (ref ? score === 1 : score >= SAME_NOTE)) best = { dir, sueId, note, score };
    }
  }
  return best;
}

/**
 * One note's record as the room reads it: the note, the principle a designer named, expected, got, steps, the page's
 * answers to her last moves, and her last look before she wrote it: the page's items as she read them, and `shot`, the
 * picture she took (the room sees it beside the claim). The first Packing Buddy ruling over every note (2026-10-10)
 * left 97 of 142 UNPROVEN, the seats asking for "the layout, sizes, or targets that would verify them".
 */
function recordOf({ dir, sueId, note }) {
  const p = note.problem || {};
  const lines = [`${sueId} wrote: ${clip(note.text, 400)}`];
  // Her next note on the same page, right after the claim, so a correction she wrote herself reaches the room: Raise
  // Buddy re-visit 23 (2026-10-12) ruled "NIH card has no reason line" REAL from a look that cut the card off, though six
  // seconds later she wrote "Correction: NIH card does show a reason". A body note (bored, slow) is SUE's, not hers.
  const next = readJsonl(path.join(dir, sueId, "findings.jsonl")).find(
    (n) => n.source !== "body" && n.text && String(n.at) > String(note.at) && n.url === note.url,
  );
  if (next) lines.push(`her next note on this page: ${clip(next.text, 300)}`);
  if (note.why) lines.push(`why: ${clip(note.why, 200)}`);
  if (p.expected) lines.push(`expected: ${clip(p.expected, 300)}`);
  if (p.actual) lines.push(`got: ${clip(p.actual, 300)}`);
  if (Array.isArray(p.steps) && p.steps.length) lines.push(`steps: ${p.steps.map((s) => clip(s, 120)).join(" > ")}`);
  const before = readJsonl(path.join(dir, sueId, "trace.jsonl")).filter((m) => m.tool && String(m.at) <= String(note.at));
  const moves = before.filter((m) => !["look", "note", "wait"].includes(m.tool) && m.result);
  for (const m of moves.slice(-4)) lines.push(`${m.tool}${m.args?.text ? ` "${clip(m.args.text, 60)}"` : ""} -> the page: ${clip(m.result, 260)}`);
  const look = before.filter((m) => m.tool === "look").at(-1);
  if (look?.pageText) lines.push(`the page she looked at: ${clip(String(look.pageText).split(/\r?\n/).filter(Boolean).join(" | "), 900)}`);
  const shot = look?.screenshot && existsSync(look.screenshot) ? look.screenshot : null;
  return { lines, shot };
}

/** The picture a claim's first source took when it was written, or null. */
const shotOf = (c) => c.sources?.find((s) => s.shot)?.shot ?? null;

/** The pictures a batch carries, one per claim that kept one, in claim order: the images its sitting sends the seats. */
export function picturesOf(batch) {
  return [...new Set(batch.map(shotOf).filter(Boolean))];
}

/**
 * One claim as the room reads it: its number, its text, who said it on which screen, their words and their record.
 * `picture` is the number of her screen among the sitting's pictures (picturesOf), when the sitting sends it.
 */
export function claimLine(c, picture = null) {
  const said = c.sources
    .map((s) => `${s.who}${s.run ? ` run ${s.run}` : ""}${s.screen ? ` on ${s.screen}` : ""}`)
    .join("; ");
  const words = c.sources.flatMap((s) => s.words).slice(0, 4);
  const record = c.sources.flatMap((s) => s.evidence || []).slice(0, 10);
  return [
    `${c.id}. ${c.text}`,
    `   said by: ${said}`,
    ...(words.length ? [`   their words: ${words.join(" | ")}`] : []),
    ...(record.length ? ["   their record:", ...record.map((e) => `   - ${e}`)] : []),
    ...(picture ? [`   her screen: picture ${picture}`] : []),
  ].join("\n");
}

/**
 * The claims cut into batches, each within `maxChars` of claim text (one claim is never split; a claim longer than the
 * cap is a batch of its own). Pure.
 */
export function batchClaims(claims, maxChars = BATCH_MAX_CHARS) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const c of claims) {
    const len = claimLine(c).length;
    if (cur.length && size + len > maxChars) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** The text of one batch sent into the meeting: the instruction, then the numbered claims with their evidence. */
export function rulingRequest(batch) {
  const pictures = picturesOf(batch);
  const numbered = batch.map((c) => claimLine(c, pictures.indexOf(shotOf(c)) + 1 || null));
  return [RULING_INSTRUCTION, "", "The claims:", ...numbered].join("\n");
}

/**
 * A seat's reply, read per claim id. Lines of the shape "C3: REAL - why" (NOT REAL and CAN'T TELL included; the tolerant
 * forms "C3 - real", "C3. NOT REAL" also read). An id the reply does not rule on is absent, never guessed. Pure.
 * Returns Map<id, { ruling: "real" | "notReal" | "cantTell", why }>.
 */
export function parseRulings(text, ids) {
  const wanted = new Set(ids);
  const out = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = /^\W*(C\d+)\W{0,3}\s*(NOT\s+REAL|REAL|CAN.?T\s+TELL)\b\W*\s*(.*)$/i.exec(raw.trim());
    if (!m || !wanted.has(m[1].toUpperCase()) || out.has(m[1].toUpperCase())) continue;
    const word = m[2].toUpperCase().replace(/\s+/g, " ");
    const ruling = word.startsWith("NOT") ? "notReal" : word.startsWith("CAN") ? "cantTell" : "real";
    out.set(m[1].toUpperCase(), { ruling, why: m[3].trim() });
  }
  return out;
}

/**
 * How many seats must rule on a claim before their majority stands: three, or the whole room when it seats fewer.
 * Packing Buddy, 2026-10-10: one seat's line made a claim REAL while four answered in prose.
 */
export const RULING_QUORUM = 3;

/**
 * The ruling on one claim from its seats' replies. `votes` is [{ seat, ruling, why }] for every seat that answered
 * (a seat whose turn failed is not in it). Under `quorum` replies it is UNPROVEN; else REAL only on a majority of the
 * replies, NOT REAL on a majority the other way, otherwise UNPROVEN. Pure.
 */
export function rulingOf(votes, quorum = 1) {
  const n = votes.length;
  if (!n || n < quorum) return "UNPROVEN";
  const real = votes.filter((v) => v.ruling === "real").length;
  const notReal = votes.filter((v) => v.ruling === "notReal").length;
  if (real * 2 > n) return "REAL";
  if (notReal * 2 > n) return "NOT REAL";
  return "UNPROVEN";
}

/**
 * Every claim of the field, ruled. `sitBatch({ batch, seats })` holds one sitting over the batch and returns
 * { answers: { [seat]: text } } (a seat that did not answer is absent) or throws when the room cannot be reached.
 * Returns { rulings: [...], counts, seatsSat, batches }. Pure given sitBatch. A room that sits nobody throws.
 */
export async function ruleClaims({ claims, seats, sitBatch, maxChars = BATCH_MAX_CHARS, together = SITTINGS_AT_ONCE }) {
  const rulings = claims.map((c) => ({ ...c, votes: [] }));
  const seatsSat = new Set();
  // A seat that gave no ruling in a batch, with the door's reason (rule-claims.mjs `skipped`), so a quiet seat is named.
  const quiet = {};
  const batches = batchClaims(claims, maxChars);
  const sit = async (batch) => {
    const ids = batch.map((c) => c.id);
    const sat = await sitBatch({ batch, seats, text: rulingRequest(batch), images: picturesOf(batch) });
    for (const [seat, why] of Object.entries(sat?.skipped || {})) quiet[seat] = why;
    const answers = sat?.answers || {};
    for (const [seat, text] of Object.entries(answers)) {
      if (!text) continue;
      const parsed = parseRulings(text, ids);
      if (!parsed.size) {
        quiet[seat] = `its reply ruled on no claim id: ${String(text).replace(/\s+/g, " ").slice(0, 120)}`;
        continue;
      }
      seatsSat.add(seat);
      for (const [id, v] of parsed) rulings.find((r) => r.id === id).votes.push({ seat, ruling: v.ruling, why: v.why });
    }
  };
  // The first sitting alone (it finds or makes the room's seats in the workspace), then the rest `together` at a time.
  if (batches.length) await sit(batches[0]);
  for (let i = 1; i < batches.length; i += together) await Promise.all(batches.slice(i, i + together).map(sit));
  for (const r of rulings) r.votes.sort((a, b) => seats.indexOf(a.seat) - seats.indexOf(b.seat));
  if (!seatsSat.size && claims.length) throw new Error("no seat of the room answered a single claim");
  const quorum = Math.min(RULING_QUORUM, seats.length);
  const ruled = rulings.map((r) => ({ ...r, ruling: rulingOf(r.votes, quorum), counts: countsOf(r.votes) }));
  const counts = { REAL: 0, "NOT REAL": 0, UNPROVEN: 0 };
  for (const r of ruled) counts[r.ruling] += 1;
  return { rulings: ruled, counts, seatsSat: [...seatsSat], quiet, batches: batches.map((b) => b.map((c) => c.id)) };
}

/** How many of a claim's replies said each thing. */
export function countsOf(votes) {
  return {
    real: votes.filter((v) => v.ruling === "real").length,
    notReal: votes.filter((v) => v.ruling === "notReal").length,
    cantTell: votes.filter((v) => v.ruling === "cantTell").length,
  };
}

/** The one line the hearing log and --status print for a finished ruling. */
export function renderCountsLine(counts, total) {
  return `${total} claim(s) from the field: ${counts.REAL} REAL, ${counts["NOT REAL"]} NOT REAL, ${counts.UNPROVEN} UNPROVEN`;
}

/** rulings.md: every claim with its ruling, its evidence, and each seat's vote and reason. Pure. */
export function renderRulingsMd(result) {
  const total = result.rulings.length;
  const lines = [
    "# Rulings on the field's claims",
    "",
    renderCountsLine(result.counts, total),
    `Seats that answered: ${result.seatsSat.length ? result.seatsSat.join(", ") : "none"}. A claim is REAL only on a majority of at least ${RULING_QUORUM} replies (all of them in a smaller room).`,
    ...Object.entries(result.quiet || {}).map(([seat, why]) => `Gave no ruling: ${seat} - ${why}`),
    "",
  ];
  for (const r of result.rulings) {
    lines.push(`## ${r.id} - ${r.ruling}`, "", claimLine(r), "");
    const c = r.counts;
    lines.push(`Replies: ${c.real} real, ${c.notReal} not real, ${c.cantTell} can't tell.`);
    for (const v of r.votes) lines.push(`- ${v.seat}: ${RULINGS[v.ruling]}${v.why ? ` - ${v.why}` : ""}`);
    if (!r.votes.length) lines.push("- no reply on this claim");
    lines.push("");
  }
  if (!total) lines.push("The field reported no claims, so the room had nothing to rule on.");
  return `${lines.join("\n")}\n`;
}

/** The claims the room ruled REAL: the only ones the drafter and the docket's work may read. Pure. */
export function realClaims(result) {
  return (result?.rulings || []).filter((r) => r.ruling === "REAL");
}

/** The drafter's block of REAL claims (empty when none): the claims the room ruled real, with the reason each was real. */
export function realClaimsText(result) {
  const real = realClaims(result);
  if (!real.length) return "";
  return real
    .map((r) => {
      const why = r.votes.filter((v) => v.ruling === "real" && v.why).map((v) => v.why)[0];
      return `- ${r.text}${r.screen ? ` (on ${r.screen})` : ""}${why ? ` - ${why}` : ""}`;
    })
    .join("\n");
}

/**
 * Read the field's logs from a docket and rule on every claim with the room. `sitBatch` defaults to the Connections
 * Boardroom door (rule-claims.mjs), started through `run` (lib/collect.mjs runAsync, so sittings run side by side; the
 * synchronous run works too, one sitting after another). Writes rulings.json and rulings.md into the docket. Throws when the room cannot be reached; the caller says
 * so and drafts nothing.
 */
export async function ruleFieldClaims({
  root,
  docketDir,
  seats,
  seatsDir = null,
  sitBatch = null,
  run = null,
  runsRoot = CHECKOUT,
  log = () => {},
}) {
  const logs = {};
  for (const name of ["sue.log", "ape.log", "art.log"]) {
    const p = path.join(docketDir, name);
    if (existsSync(p)) logs[name] = readFileSync(p, "utf8");
  }
  const claims = fieldClaims(logs, { runsRoot });
  const door = sitBatch || ((req) => sitRulingBatch({ root, docketDir, seats, seatsDir, run, ...req }));
  if (claims.length) log(`rulings: ${claims.length} claim(s) in ${batchClaims(claims).length} sitting(s), ${SITTINGS_AT_ONCE} at a time`);
  const result = claims.length
    ? await ruleClaims({ claims, seats, sitBatch: door })
    : { rulings: [], counts: { REAL: 0, "NOT REAL": 0, UNPROVEN: 0 }, seatsSat: [], batches: [] };
  writeFileSync(path.join(docketDir, "rulings.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(docketDir, "rulings.md"), renderRulingsMd(result));
  const line = renderCountsLine(result.counts, result.rulings.length);
  log(`rulings: ${line}`);
  return result;
}

/** A finished SUE run belongs to the selected target's .sue store, not this tool's source tree. */
export const runDirOf = (root, runId) => path.join(root, ".sue", "runs", runId);

/**
 * The kind of a finished run, read from its own folder: an ART run carries the design review (`art` in its report or
 * manifest), an APE run is marked `ape`, anything else is plain SUE. Null-safe on an unreadable file. Pure over the folder.
 */
export function runKindOf(runDir) {
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(path.join(runDir, name), "utf8"));
    } catch {
      return {};
    }
  };
  const manifest = read("manifest.json");
  const report = read("report.json");
  if (report.art || manifest.art || manifest.args?.art) return "art";
  if (manifest.ape || manifest.args?.ape || report.ape) return "ape";
  return "sue";
}

/**
 * The results rows a docket adopts from finished runs (`--run <runId>[,<runId>...]`): each run is collected as SUE, APE
 * or ART by its own kind, so the room rules on findings already on disk without launching a visitor. An entry may name
 * its kind (`art:<runId>`). A run with no folder is refused by name. Pure over the folders.
 */
export function adoptRuns(root, entries) {
  return entries.map((entry) => {
    const named = /^(sue|ape|art):(.+)$/i.exec(entry);
    const runId = named ? named[2] : entry;
    const dir = runDirOf(root, runId);
    if (!existsSync(dir)) throw new Error(`--run ${runId}: no finished run folder at ${dir}`);
    const kind = named ? named[1].toLowerCase() : runKindOf(dir);
    return { id: kind, runId, status: "adopted (a finished run, not launched by this docket)", at: new Date().toISOString() };
  });
}

/**
 * The domain a docket of adopted visitor runs sits under. Their findings are about the page they walked, so a code domain
 * the classifier read off the hand-off's words (it names SUE, ART and APE) is the product's: the Packing Buddy field's
 * evidence sat the tooling room, with every rung of the ladder unchecked (2026-10-11). Runs with no page stay as read.
 */
export function adoptedDomain(domain, url) {
  return url && CODE_DOMAINS.includes(domain) ? "product" : domain;
}

/** A prior rulings file on the docket, read back for a resumed hearing (null when none, or unreadable). */
export function readRulings(docketDir) {
  const p = path.join(docketDir, "rulings.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * One batch's sitting over the Connections Boardroom: rule-claims.mjs (bun) writes its answers to a file. Throws when the
 * room cannot be reached, with the room's own words; never a fallback that rules without the room. `run` is the
 * hearing's command door (lib/collect.mjs run): on Windows bun is an npm shim (bun.cmd) that a bare spawn cannot start,
 * which ended the first Packing Buddy ruling with "spawnSync bun ENOENT" (2026-10-10).
 */
export async function sitRulingBatch({ root, docketDir, seats, seatsDir = null, batch = [], text, images = [], run }) {
  if (typeof run !== "function") throw new Error("sitRulingBatch needs the hearing's command door (lib/collect.mjs run)");
  // Named by the batch's first claim too: sittings started in the same millisecond each keep their own files.
  const stem = path.join(docketDir, `rulings-batch-${Date.now()}-${batch[0]?.id ?? "c"}`);
  const requestFile = `${stem}.request.json`;
  const outFile = `${stem}.answers.json`;
  writeFileSync(
    requestFile,
    JSON.stringify({
      root,
      seats: seats.map((s) => s.id ?? s),
      seatsDir,
      text,
      images,
      cacheFile: path.join(root, "tmp", "dredd", "connections-board.json"),
    }),
  );
  const r = await run("bun", [RULE_SCRIPT, requestFile, outFile], { cwd: root, timeoutMs: 20 * 60_000 });
  const answered = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null;
  if (!answered || answered.error || r.status !== 0) {
    const why = answered?.error || String(r.error || r.stderr || `exit ${r.status}`).trim().slice(-400);
    throw new Error(`the Connections Boardroom could not be reached for the rulings: ${why}`);
  }
  return answered;
}

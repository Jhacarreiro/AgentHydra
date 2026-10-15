// dredd/lib/converge.mjs - the convergence ruling: every requirement the ask states, against the diff, gaps as traced tasks.
//
// WHY: the owner's standing complaint is agents drifting from a clearly stated ask. An agent's own "done" is a claim,
// not evidence, so this ruling lists every requirement the ask states (FR-001, SC-002, US1... or R1, R2... for a plain
// list), reads the diff for evidence of each, and returns one finding per gap in four classes - missing, partial,
// contradicts, unrequested - each traced to the requirement it came from, with one task line to append. The build step
// and this ruling loop until the verdict is "converged" (`node dredd/dredd.mjs --converge`).
// The idea is github/spec-kit's converge step (templates/commands/converge.md, MIT); written fresh for Dredd, no code copied.
//
// Pure: the ask text, a unified diff and (optionally) the tasks file in; findings out. dredd.mjs is the plumbing (it
// reads the files and runs git). The evidence test is lexical - a requirement's key terms in the lines the diff adds
// and the paths it touches - so a finding is a lead the agent confirms, never a proof. It errs toward too few
// "unrequested" (a file sharing one term with any requirement passes), never toward inventing scope creep.
import { keyTerms } from "./docket.mjs";

/** Share of a requirement's terms the diff must carry for it to count as met; any fewer, but at least one, is partial. */
export const MET_AT = 0.6;

/** Requirement boilerplate that names no part of the work: it would count as evidence everywhere. */
const NOISE = new Set(
  "shall must should need needs never without avoid system user users able allow allows when which there where while also make sure ensure every file files code change changes added adds include includes support supports provide provides call calls using".split(
    " ",
  ),
);

/** An explicit requirement id at the head of a line: "FR-001: ...", "- **SC-002** ...", "US1. ...", "AC-3) ...". An
 *  unhyphenated id needs a known requirement prefix: "- S3 uploads", "- K8s pods" or "- EC2 hosts" is a plain list
 *  item, and taking it for an id would switch the ask to explicit mode and drop every other item without a word. */
const ID_LINE_RX =
  /^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?\**((?:[A-Z]{1,5}-\d{1,4}|(?:FR|NFR|SC|US|AC|REQ|R)\d{1,4})[a-z]?)\**\s*[:.)-]?\s+(.+)$/;
/** A list item: "- ...", "* ...", "1. ...", "2) ...". */
const LIST_LINE_RX = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;
/** The part of a requirement that forbids: what follows it is what the diff must not add. Modal negations only: "export
 *  contacts without reloading the page" asks for an export, it does not forbid the word "page". */
const NEGATION_RX = /\b(?:must not|mustn'?t|shall not|should not|shouldn'?t|never|do not|don'?t|does not)\s+(.+)$/i;

/** A word reduced to the stem both sides are compared on: plural, past and -ing endings off, then a silent final e, so
 *  "include", "includes" and "included" all meet at "includ". */
export function stem(word) {
  let w = String(word).toLowerCase();
  for (const suffix of ["ing", "ed", "es", "s"])
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  return w.length >= 5 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** How many of a requirement's forbidden terms one added line must carry to contradict it: all of one or two, all but
 *  one of three (the phrase after "must not" often keeps a verb the code names differently: "call" vs "send"). */
export function forbidHitsNeeded(forbids) {
  return forbids.length >= 3 ? forbids.length - 1 : forbids.length;
}

/** The terms a requirement is judged on: its key nouns and verbs, boilerplate off, stemmed. */
export function termsOf(text, limit = 8) {
  const out = [];
  for (const t of keyTerms(text, 60)) {
    if (NOISE.has(t)) continue;
    const s = stem(t);
    if (!out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Every stem in a line of code or a path: identifiers split at camelCase, snake_case, kebab-case and slashes. */
export function tokensOf(text) {
  const words = String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  return new Set(words.map(stem));
}

/**
 * The requirements the ask states, each with an id. Explicit ids win (a spec's FR-001 / SC-002 / US1 lines); with none,
 * each list item is one (R1, R2...); with no list, each sentence that names anything. Headings are never requirements.
 */
export function extractRequirements(ask) {
  const lines = String(ask || "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*#/.test(l));
  const explicit = lines.map((l) => ID_LINE_RX.exec(l)).filter(Boolean);
  if (explicit.length) return explicit.map((m) => requirement(m[1], m[2]));
  const listed = lines.map((l) => LIST_LINE_RX.exec(l)).filter(Boolean);
  const texts = listed.length
    ? listed.map((m) => m[1])
    : lines
        .join(" ")
        .split(/(?<=[.!?;])\s+/)
        .map((s) => s.trim());
  return texts.filter((t) => termsOf(t).length).map((t, i) => requirement(`R${i + 1}`, t));
}

function requirement(id, raw) {
  const text = raw.trim().replace(/\s+/g, " ");
  const neg = NEGATION_RX.exec(text);
  const forbids = neg ? termsOf(neg[1], 3) : [];
  const terms = termsOf(neg ? text.slice(0, neg.index) : text).filter((t) => !forbids.includes(t));
  return { id, text, terms, forbids };
}

/** A unified diff (git diff) as one row per file: its path, the lines it adds and the lines it removes. */
export function parseDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of String(diff || "").split(/\r?\n/)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { file: head[2], added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const p = line.slice(4).replace(/^[ab]\//, "");
      if (line.startsWith("+++ ") && p !== "/dev/null") cur.file = p;
    } else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

/** The requirement ids a tasks file claims done: every checked line ("- [x] ...") that names one. */
export function claimedDone(tasks, ids) {
  const done = new Set();
  for (const line of String(tasks || "").split(/\r?\n/)) {
    if (!/^\s*[-*+]\s+\[[xX]\]/.test(line)) continue;
    for (const id of ids) if (new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(line)) done.add(id);
  }
  return done;
}

/**
 * The ruling. Each requirement is met, partial or missing by how many of its terms the diff's added lines and touched
 * paths carry; a requirement that forbids something is contradicted when one added line carries its forbidden terms
 * (forbidHitsNeeded);
 * a changed file none of the requirements' terms reach is unrequested. A requirement the tasks file ticks off with no
 * evidence says so: the tick was a claim. Returns { verdict, requirements, findings, tasks }.
 * `exclude` names diff paths that are the ruling's own inputs (the ask file, the tasks file): they repeat every
 * requirement word for word, so counting them as evidence would rule an unbuilt ask converged.
 */
export function converge({ ask, diff, tasks = "", exclude = [] }) {
  const reqs = extractRequirements(ask);
  const skip = new Set(exclude);
  const files = parseDiff(diff).filter((f) => !skip.has(f.file));
  const claimed = claimedDone(
    tasks,
    reqs.map((r) => r.id),
  );
  const evidence = new Set();
  for (const f of files) for (const t of [...tokensOf(f.file), ...f.added.flatMap((l) => [...tokensOf(l)])]) evidence.add(t);
  const findings = [];
  const rows = reqs.map((r) => {
    const hit = r.terms.filter((t) => evidence.has(t));
    const lack = r.terms.filter((t) => !evidence.has(t));
    let status = r.terms.length === 0 ? "unjudged" : hit.length / r.terms.length >= MET_AT ? "met" : hit.length ? "partial" : "missing";
    if (status === "partial" || status === "missing") {
      const claim = claimed.has(r.id) ? "; the tasks tick it done, which is a claim, not evidence" : "";
      findings.push({
        class: status,
        ref: r.id,
        requirement: r.text,
        evidence: hit.length
          ? `carried: ${hit.join(", ")}; not carried: ${lack.join(", ")}${claim}`
          : `none of: ${lack.join(", ")}${claim}`,
      });
    }
    if (r.forbids.length) {
      for (const f of files) {
        const line = f.added.find((l) => {
          const toks = tokensOf(l);
          return r.forbids.filter((t) => toks.has(t)).length >= forbidHitsNeeded(r.forbids);
        });
        if (!line) continue;
        status = "contradicts";
        findings.push({ class: "contradicts", ref: r.id, requirement: r.text, evidence: `${f.file} adds "${line.trim().slice(0, 120)}"` });
        break;
      }
    }
    return { ...r, status, claimed: claimed.has(r.id) };
  });
  const wanted = new Set(reqs.flatMap((r) => [...r.terms, ...r.forbids]));
  for (const f of files) {
    const toks = new Set([...tokensOf(f.file), ...[...f.added, ...f.removed].flatMap((l) => [...tokensOf(l)])]);
    if (wanted.size && ![...wanted].some((t) => toks.has(t)))
      findings.push({
        class: "unrequested",
        ref: f.file,
        requirement: null,
        evidence: `no requirement's terms appear in ${f.file} or its changed lines`,
      });
  }
  const taskLines = findings.map((g) => taskLine(g));
  return { verdict: findings.length ? "not converged" : "converged", requirements: rows, findings, tasks: taskLines };
}

/** One gap as the task line the build step picks up next, citing the requirement (or the file) it traces to. */
export function taskLine(g) {
  if (g.class === "unrequested")
    return `- [ ] [unrequested] ${g.ref}: no requirement asks for this change - revert it, or trace it to one (${g.evidence})`;
  const verb = g.class === "contradicts" ? "remove what contradicts" : g.class === "partial" ? "finish" : "implement";
  return `- [ ] [${g.class}] ${g.ref}: ${verb} "${g.requirement}" (${g.evidence})`;
}

/**
 * The tasks file with the ruling's tasks appended under one dated heading. A gap already open there (the same class and
 * ref on an unchecked line) is not appended twice, so the loop can rule again after every build step. Pure.
 */
export function appendTasks(existing, taskLines, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const text = String(existing || "");
  const open = new Set(
    text
      .split(/\r?\n/)
      .map((l) => /^\s*-\s+\[ \]\s+\[(\w+)\]\s+(\S+?):/.exec(l))
      .filter(Boolean)
      .map((m) => `${m[1]} ${m[2]}`),
  );
  const fresh = taskLines.filter((l) => {
    const m = /^- \[ \] \[(\w+)\] (\S+?):/.exec(l);
    return !m || !open.has(`${m[1]} ${m[2]}`);
  });
  if (!fresh.length) return { text, appended: 0 };
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  return { text: `${text}${sep}${text ? "\n" : ""}## Convergence (${date})\n\n${fresh.join("\n")}\n`, appended: fresh.length };
}

/** The ruling as the agent reads it: the verdict, each requirement's status, then the task lines. */
export function renderConverge(r) {
  const lines = [`converge: ${r.verdict} - ${r.requirements.length} requirement(s), ${r.findings.length} gap(s)`];
  for (const q of r.requirements)
    lines.push(`  ${q.status.padEnd(11)} ${q.id}  ${q.text.slice(0, 100)}${q.claimed ? "  (ticked done)" : ""}`);
  if (r.tasks.length) lines.push("", "tasks:", ...r.tasks);
  return lines.join("\n");
}

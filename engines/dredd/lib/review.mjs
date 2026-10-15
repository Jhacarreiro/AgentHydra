/**
 * The code-review roster and its coordinator - pure, so every rule below is tested without a model.
 * =================================================================================================
 *
 * WHY: nothing in the fleet reviewed a CHANGE (a branch, a diff, a pull request) as a gate: the house critics argue an
 * ask, and the review skills are single-session prompts. Two harvested designs, built once (2026-09-24):
 *   - react-native's .expo-code-review (MIT): one markdown file per reviewer, frontmatter `description` / `alwaysRun`,
 *     `@ref glob:` lines route it to paths, a shared preamble, and a coordinator that dedupes, re-ranks and returns ONE
 *     verdict (approve / approve_with_comments / request_changes) on a rubric that leans toward approval. The diff is
 *     untrusted, and a critical or security finding can never be dismissed.
 *   - mattpocock/skills code-review (MIT): Standards and Spec are separate reviewers whose reports are never merged or
 *     re-ranked against each other, and the summary names the worst finding on each axis - so a change that follows
 *     every rule but builds the wrong thing cannot read as clean.
 * A third, 2026-10-07: tester-army/e2e's review triage (.claude/skills/babysit/references/review-triage.md @ b7ba009,
 * Apache-2.0). A dismissal (`--dismiss`, or the inline ignore marker) names its disproof: one of five kinds and the one
 * fact it cites, checked against the repository, never free text. A finding on auth, a public contract or a wire
 * schema escalates (reviewers/escalate.json): the judge never dismisses it alone. And after two rounds of new edge
 * cases on one function, a third round's new findings there are residue, named and out of the verdict.
 * Ideas only; the code is written fresh for Dredd. Every reviewer declares its `axis`; the coordinator dedupes and
 * re-ranks WITHIN an axis only, each axis gets its own verdict, and the overall verdict is the stricter of the two.
 * The rules that decide the verdict live here in code, never in a prompt a diff could talk its way past.
 */
import { createHash } from "node:crypto";
import path from "node:path";

export const AXES = ["standards", "spec"];
export const SEVERITIES = ["critical", "important", "minor"];
export const VERDICTS = ["approve", "approve_with_comments", "request_changes"];
/** The only thing in a change that suppresses a finding: this marker and a disproof, on the flagged line or the one above. */
export const IGNORE_MARKER = "dredd-review-ignore:";
/**
 * The five ways a finding is shown wrong (review-triage.md "Dismiss with a disproof", tester-army/e2e, Apache-2.0,
 * ideas only). A dismissal is `<kind>:<citation> [note]`: the citation is the one fact that disproves the finding, and
 * the note is never the proof.
 */
export const DISPROOF_KINDS = {
  "pre-existing": "pre-existing: the flagged line predates this change",
  "misread-semantics": "misread library semantics",
  guaranteed: "already guaranteed by a helper, a type or a closed schema",
  "trade-off": "an intentional trade-off, on record",
  "repo-rule": "a tool rule that contradicts a repo rule",
};
/** The findings the judge never dismisses alone, in the order a finding is classed (reviewers/escalate.json keys). */
export const ESCALATION_CLASSES = ["auth", "public-contract", "wire-schema"];
/** Rounds of new edge cases one function takes before a later round's new findings there are residue. */
export const ROUND_CAP = 2;

/** The answer every reviewer returns (the HSwarm schema). The verdict is not in it: the coordinator computes that. */
export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          category: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          title: { type: "string" },
          why: { type: "string" },
          quote: { type: "string" },
          specQuote: { type: "string" },
        },
        required: ["severity", "title"],
      },
    },
  },
  required: ["findings"],
};

/**
 * A reviewer or rule file's frontmatter: `key: value` pairs and `key:` followed by `  - item` lists, between the
 * leading `---` lines. Returns { meta, body }; a file with no frontmatter is all body.
 */
export function frontmatter(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    listKey = null;
    if (kv[2] === "") {
      listKey = kv[1];
      meta[listKey] = [];
    } else meta[kv[1]] = unquote(kv[2]);
  }
  return { meta, body: src.slice(m[0].length) };
}

function unquote(v) {
  const t = String(v).trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** One reviewer file: its routing globs come out of the body, the rest of the body is its prompt. */
export function parseReviewer(text, file) {
  const { meta, body } = frontmatter(text);
  const id = path.basename(String(file), ".md");
  const globs = [];
  const prompt = body
    .split(/\r?\n/)
    .filter((line) => {
      // A glob may sit in backticks, so a markdown formatter never reads its stars as emphasis.
      const ref = /^\s*@ref\s+glob:\s*`?([^`\s]+)`?\s*$/.exec(line);
      if (ref) globs.push(ref[1]);
      return !ref;
    })
    .join("\n")
    .trim();
  const axis = String(meta.axis || "").trim();
  if (!AXES.includes(axis)) throw new Error(`reviewer ${id}: axis must be one of ${AXES.join(", ")}, not "${axis}"`);
  if (!meta.description) throw new Error(`reviewer ${id}: frontmatter needs a description`);
  const alwaysRun = String(meta.alwaysRun || "").trim() === "true";
  if (!alwaysRun && !globs.length) throw new Error(`reviewer ${id}: not alwaysRun and no @ref glob line, so it never runs`);
  // WHY: `security: true` marks the seat, not the model's wording: every finding it returns is a security finding.
  const security = String(meta.security || "").trim() === "true";
  return { id, description: meta.description, axis, alwaysRun, security, globs, prompt };
}

/** A repository path against one glob, on forward slashes whatever the platform wrote. */
export function pathMatches(p, glob) {
  return path.posix.matchesGlob(String(p).replace(/\\/g, "/"), glob);
}

/** The commit a post-land checkpoint ask names (.claude/hooks/dredd-checkpoint.mjs checkpointAsk), else null. */
export function landedCommit(ask) {
  return /^review what just landed in ([0-9a-f]{7,40})\b/.exec(String(ask || ""))?.[1] || null;
}

/** The landed paths a checkpoint ask writes out (its first six; the rest are only counted). */
export function landedPaths(ask) {
  if (!landedCommit(ask)) return [];
  const m = /.*people see: (.+?)(?: and \d+ more)?$/.exec(String(ask));
  return m ? m[1].split(", ").filter(Boolean) : [];
}

/**
 * What the change is diffed against. A landed commit is reviewed as itself, `<sha>~1..<sha>`: after a land origin/main
 * already holds it, so the merge-base diff is empty and read as a clean approval (32abc5cefa, 2026-10-01). An explicit
 * --base wins over the commit a docket's ask names; an explicit --commit wins over both. `from` is the range's own
 * base when the range names one (a pre-existing disproof must cite a commit at or before it); in merge-base mode the
 * command asks git for it. `commit` is the revision reviewed, null for the working tree.
 */
export function reviewRange({ base = null, commit = null, ask = "" } = {}) {
  const sha = commit || (base ? null : landedCommit(ask));
  if (sha) return { args: [`${sha}~1`, sha], label: `${sha}~1..${sha}`, from: `${sha}~1`, commit: sha };
  return { args: ["--merge-base", base || "origin/main"], label: base || "origin/main", from: null, commit: null };
}

/**
 * Who reviews this change: every alwaysRun reviewer, and every specialist one of whose globs matches a changed path.
 * Each picked reviewer carries the paths it matched (all of them for an alwaysRun one): it is shown only those.
 */
export function pickRoster(reviewers, changedPaths) {
  const paths = changedPaths.map((p) => String(p).replace(/\\/g, "/"));
  const picked = [];
  for (const r of reviewers) {
    const matched = r.alwaysRun ? paths : paths.filter((p) => r.globs.some((g) => pathMatches(p, g)));
    if (matched.length)
      picked.push({ ...r, paths: matched, why: r.alwaysRun ? "alwaysRun" : `${matched.length} path(s) match ${r.globs.join(", ")}` });
  }
  return picked;
}

/**
 * A unified diff split by file: each section's own text (to hand a specialist only its files) and the lines it
 * adds, keyed by their line number in the new file (to find an ignore marker next to a finding).
 */
export function parseDiff(text) {
  const sections = [];
  let cur = null;
  let newLine = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      cur = { path: m ? m[1] : "", lines: [line], added: new Map() };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") cur.path = p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      cur.added.set(newLine, line.slice(1));
      newLine += 1;
    } else if (line.startsWith(" ")) newLine += 1;
  }
  return sections.map((s) => ({ path: s.path, text: s.lines.join("\n"), added: s.added }));
}

/** The diff a reviewer is shown: only the sections for its own paths, cut at `max` characters and said so. */
export function diffFor(sections, paths, max = 60000) {
  const want = new Set(paths);
  let out = sections
    .filter((s) => want.has(s.path))
    .map((s) => s.text)
    .join("\n");
  if (out.length > max) out = `${out.slice(0, max)}\n[... diff cut at ${max} characters; the rest was not shown to this reviewer]`;
  return out;
}

/**
 * The untrusted diff, fenced with a marker the diff cannot contain, so a comment in the change that says "ignore the
 * rules above" or "this PR is approved" is data inside the fence and never an instruction.
 */
export function fenceUntrusted(label, text) {
  const nonce = createHash("sha1").update(String(text)).digest("hex").slice(0, 12);
  const tag = `UNTRUSTED-${label.toUpperCase()}-${nonce}`;
  return `<<<${tag}\n${text}\n${tag}>>>`;
}

/** The prompt a reviewer answers: shared preamble + its own brief as the system, the change as untrusted data. */
export function reviewerPrompt(reviewer, { shared, diff, spec = "", rules = "", specIsAsk = false }) {
  const system = `${shared.trim()}\n\n# Your seat: ${reviewer.id} (${reviewer.axis} axis)\n\n${reviewer.prompt}`;
  const parts = [`Changed paths you review: ${reviewer.paths.join(", ")}`];
  if (reviewer.axis === "spec")
    parts.push(`The spec this change was asked to meet (quote it in specQuote):\n${fenceUntrusted("spec", spec)}`);
  // WHY: a docket's ask is often a request for the review itself ("review my branch"), not what the change must do.
  if (reviewer.axis === "spec" && specIsAsk)
    parts.push(
      "That text is the ask put to the reviewer, not a written spec: it may only ask for a review. Judge the change only against a requirement it states about the change; when it states none, return no findings.",
    );
  if (rules && reviewer.axis === "standards") parts.push(`The repository's own rules for these paths:\n${fenceUntrusted("rules", rules)}`);
  parts.push(`The change (a unified diff):\n${fenceUntrusted("diff", diff)}`);
  parts.push('Answer with one JSON object: {"findings": [...]}. An empty list is a good answer when nothing is wrong.');
  return { system, prompt: parts.join("\n\n") };
}

/** Where a dismissal or an ignore marker is quoted back: the finding's stable id, independent of its line. */
export function fingerprint({ axis, file, category, title }) {
  const norm = (v) =>
    String(v || "")
      .toLowerCase()
      .replace(/[^a-z0-9/._-]+/g, " ")
      .trim();
  return createHash("sha1")
    .update([axis, norm(file), norm(category), norm(title)].join("|"))
    .digest("hex")
    .slice(0, 10);
}

const clip = (v, n) => String(v ?? "").slice(0, n);
const down = (sev) => SEVERITIES[Math.min(SEVERITIES.indexOf(sev) + 1, SEVERITIES.length - 1)];
const isSecurity = (f) => /secur/i.test(f.category);

/**
 * The class a finding escalates as, or null: every security finding (the seat forces the category) is `auth`; else the
 * first class, in ESCALATION_CLASSES order, one of whose category words or path globs matches it. The model's category
 * word can only ADD protection here, never take it away, so it cannot steer a finding out of escalation.
 */
export function escalationOf(f, classes = {}) {
  if (isSecurity(f)) return "auth";
  const category = String(f.category || "").toLowerCase();
  for (const c of ESCALATION_CLASSES) {
    const cls = classes[c];
    if (!cls) continue;
    if ((cls.words || []).some((w) => category.includes(w))) return c;
    if (f.file && (cls.globs || []).some((g) => pathMatches(f.file, g))) return c;
  }
  return null;
}

/**
 * One reviewer's raw answer, made safe and graded by the house rubric (which leans toward approval):
 *   - a finding on a file the change does not touch drops one level (it is not this change's to fix);
 *   - a Spec finding that quotes no spec line drops one level (it cannot say what the spec asked without quoting it);
 *   - a smell (the Fowler baseline) is a judgement call, labelled so, and never more than minor;
 *   - a security finding is never downgraded.
 * `changedPaths` is the reviewer's own paths: a finding on a file it was never shown is not this change's to fix.
 * A reviewer marked `security: true` has every finding forced to category `security`, whatever word the model wrote,
 * so neither the grading here nor an ignore marker in coordinate() can be steered by the model's choice of category.
 * `classes` (reviewers/escalate.json) names the findings that escalate: each carries `escalates: <class>` or null.
 */
export function normalizeFindings(reviewer, answer, changedPaths, classes = {}) {
  const touched = new Set(changedPaths);
  const out = [];
  for (const raw of Array.isArray(answer?.findings) ? answer.findings : []) {
    if (!raw || typeof raw !== "object" || !String(raw.title || "").trim()) continue;
    const f = {
      axis: reviewer.axis,
      reviewers: [reviewer.id],
      severity: SEVERITIES.includes(raw.severity) ? raw.severity : "minor",
      category: reviewer.security ? "security" : clip(raw.category || (reviewer.axis === "spec" ? "wrong" : "rule"), 40).toLowerCase(),
      file: clip(raw.file, 300)
        .replace(/\\/g, "/")
        .replace(/^\.?\//, ""),
      line: Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null,
      title: clip(raw.title, 200).trim(),
      why: clip(raw.why, 1200),
      quote: clip(raw.quote, 400),
      ...(reviewer.axis === "spec" ? { specQuote: clip(raw.specQuote, 400) } : {}),
      notes: [],
    };
    if (!isSecurity(f)) {
      if (f.file && !touched.has(f.file)) {
        f.severity = down(f.severity);
        f.notes.push("not in the change: downgraded");
      }
      if (f.axis === "spec" && !f.specQuote.trim()) {
        f.severity = down(f.severity);
        f.notes.push("quotes no spec line: downgraded");
      }
      if (f.category === "smell") {
        f.severity = "minor";
        f.judgementCall = true;
      }
    }
    f.escalates = escalationOf(f, classes);
    f.id = fingerprint(f);
    out.push(f);
  }
  return out;
}

/** Two findings on one axis are one when they share an id, or sit on the same file within three lines in the same category. */
function sameFinding(a, b) {
  if (a.id === b.id) return true;
  return (
    Boolean(a.file) && a.file === b.file && a.category === b.category && a.line != null && b.line != null && Math.abs(a.line - b.line) <= 3
  );
}

/** Dedupe within one axis: the first wording stays, the highest severity wins, every reviewer who saw it is named. */
export function dedupe(findings) {
  const kept = [];
  for (const f of findings) {
    const twin = kept.find((k) => k.axis === f.axis && sameFinding(k, f));
    if (!twin) {
      kept.push({ ...f, reviewers: [...f.reviewers], notes: [...f.notes] });
      continue;
    }
    for (const r of f.reviewers) if (!twin.reviewers.includes(r)) twin.reviewers.push(r);
    if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(twin.severity)) twin.severity = f.severity;
  }
  return kept;
}

/**
 * Every ignore marker the change adds, as { file, line, reason } plus the disproof its reason parses to, or the error
 * that says why it does not. A marker with no reason is not a marker.
 */
export function ignoreMarkers(sections) {
  const out = [];
  for (const s of sections) {
    for (const [line, text] of s.added) {
      const at = text.indexOf(IGNORE_MARKER);
      if (at < 0) continue;
      const reason = text
        .slice(at + IGNORE_MARKER.length)
        .replace(/\*\/|-->|#}/g, "")
        .trim();
      if (!reason) continue;
      const marker = { file: s.path, line, reason };
      try {
        marker.disproof = parseDisproof(reason);
      } catch (err) {
        marker.error = err.message;
      }
      out.push(marker);
    }
  }
  return out;
}

/**
 * The coordinator. `reports` = [{ reviewer, findings }] already normalized; `markers` from ignoreMarkers (each with a
 * checked disproof or an `error`); `dismissals` from parseDismissals, their citations already checked; `facts` =
 * { added: Map<file, Map<line, text>>, blame(file, line) -> sha | null } for a pre-existing disproof; `classes` from
 * reviewers/escalate.json; `previous` = the last run's review.json (--previous) for the round counter. Order: dedupe,
 * markers, dismissals, the dismissals that matched no finding, rounds, then each axis and the verdict.
 */
export function coordinate({
  reports,
  markers = [],
  dismissals = {},
  facts = {},
  classes = {},
  previous = null,
  failed = [],
  specGiven = true,
}) {
  const all = dedupe(reports.flatMap((r) => r.findings));
  const suppressed = [];
  const dismissed = [];
  const refused = [];
  const open = [];
  for (const f of all) {
    const marker = f.file && f.line != null ? markers.find((m) => m.file === f.file && (m.line === f.line || m.line === f.line - 1)) : null;
    if (marker) {
      const no =
        marker.error || !marker.disproof
          ? { why: marker.error || "it names no <kind>:<citation>" }
          : refuseDismissal(marker.disproof, f, facts, classes);
      if (!no) {
        suppressed.push({ ...f, ignoredBecause: marker.reason, disproof: disproofRecord(marker.disproof) });
        continue;
      }
      f.notes.push(`ignore marker refused: ${no.why}`);
    }
    const d = dismissals[f.id];
    if (d) {
      const no = refuseDismissal(d, f, facts, classes);
      if (!no) {
        dismissed.push({ ...f, disproof: disproofRecord(d) });
        continue;
      }
      refused.push(refusalRow(f.id, d, no, f));
      f.notes.push(`dismissal refused: ${no.why}`);
    }
    open.push(f);
  }
  const ids = new Set(all.map((f) => f.id));
  for (const [id, d] of Object.entries(dismissals))
    if (!ids.has(id)) refused.push(refusalRow(id, d, refuseDismissal({ ...d, id }, null, facts, classes), null));
  const { live, residue, rounds } = applyRounds(open, previous);
  const axes = {};
  for (const axis of AXES) {
    const findings = live.filter((f) => f.axis === axis).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    const judged = reports.some((r) => r.reviewer.axis === axis) && (axis !== "spec" || specGiven);
    axes[axis] = {
      judged,
      verdict: judged ? axisVerdict(findings) : null,
      worst: findings[0] || null,
      findings,
      ...(axis === "spec" && !specGiven ? { note: "no spec given (--spec or --ask): the Spec axis was not judged" } : {}),
    };
  }
  let verdict = worstVerdict(Object.values(axes).map((a) => a.verdict));
  // A reviewer that did not answer is a hole in the review, never a pass: an incomplete review cannot approve outright.
  if (failed.length && verdict === "approve") verdict = "approve_with_comments";
  return { verdict, axes, suppressed, dismissed, refused, residue, rounds, failed, ...(failed.length ? { incomplete: true } : {}) };
}

/** One refused dismissal as review.json keeps it: what was asked, the code and reason, and where the finding sits. */
function refusalRow(id, d, no, f) {
  return { id, kind: d.kind, citation: d.citation, ...no, ...(f ? { title: f.title, file: f.file, line: f.line } : {}) };
}

/** The rubric, leaning toward approval: only a critical finding, or an important security one, requests changes. */
export function axisVerdict(findings) {
  if (findings.some((f) => f.severity === "critical" || (f.severity === "important" && isSecurity(f)))) return "request_changes";
  return findings.length ? "approve_with_comments" : "approve";
}

/** The stricter of the axis verdicts; an axis not judged has no say. */
export function worstVerdict(verdicts) {
  const got = verdicts.filter(Boolean);
  if (!got.length) return "approve";
  return got.reduce((a, b) => (VERDICTS.indexOf(b) > VERDICTS.indexOf(a) ? b : a));
}

const KIND_IDS = Object.keys(DISPROOF_KINDS).join(", ");
const SHA = /^[0-9a-f]{7,40}$/;
const HTTPS = /^https:\/\/[^\s/]+\.[^\s/]+(?:\/\S*)?$/;
const OWNER_UNKNOWN = "the owner of that lane";
const isRuleFile = (p) => /(^|\/)(AGENTS|CLAUDE)[^/]*\.md$/.test(p) || /(^|\/)\.claude\/rules\/.+\.md$/.test(p);

/** A repo-relative citation path with its optional `:<line>` or `#anchor` split off; one that leaves the repository throws. */
function citedPath(text) {
  const m = /^(.+?)(?::(\d+)|#([^\s#]+))?$/.exec(text);
  const p = m[1];
  if (p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes(".."))
    throw new Error(`a citation path stays inside the repository (repo-relative, forward slashes, no ".."), not "${p}"`);
  return { path: p, ...(m[2] ? { line: Number(m[2]) } : {}), ...(m[3] ? { anchor: m[3] } : {}) };
}

/** The shape each kind's citation must have: a commit, an https:// link, a path, or `<path>:<symbol>`. */
function citationShape(kind, c) {
  if (kind === "pre-existing") {
    if (!SHA.test(c)) throw new Error(`pre-existing cites the commit git blame names for the flagged line (7-40 hex), not "${c}"`);
    return { form: "sha", sha: c };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(c)) {
    if (kind !== "misread-semantics" && kind !== "trade-off") throw new Error(`${kind} cites a file in the repository, not a link`);
    if (!HTTPS.test(c)) throw new Error(`a link citation is an https:// address, not "${c}"`);
    return { form: "url", url: c };
  }
  if (kind === "misread-semantics") {
    const p = citedPath(c);
    if (!/(^|\/)node_modules\//.test(p.path))
      throw new Error(`misread-semantics cites the library's https:// doc or its installed source under node_modules/, not "${c}"`);
    return { form: "path", ...p };
  }
  if (kind === "guaranteed") {
    const m = /^(.+):([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(c);
    if (!m) throw new Error(`guaranteed cites <path>:<symbol>, the helper, type or schema that makes it impossible, not "${c}"`);
    return { form: "symbol", ...citedPath(m[1]), symbol: m[2] };
  }
  if (kind === "trade-off" && SHA.test(c)) return { form: "sha", sha: c };
  const p = citedPath(c);
  if (kind === "repo-rule" && !isRuleFile(p.path))
    throw new Error(`repo-rule cites the repo rule itself (AGENTS*.md, CLAUDE*.md or .claude/rules/*.md); "${p.path}" is not a repo rule`);
  return { form: "path", ...p };
}

/**
 * `<kind>:<citation> [note]` as { kind, citation, note, form, ... }: form "sha" (+ sha), "url" (+ url), "path" (+ path,
 * line?, anchor?) or "symbol" (+ path, symbol). Free text, an unknown kind or a wrong-shaped citation throws the reason.
 */
export function parseDisproof(text) {
  const src = String(text ?? "").trim();
  const m = /^([a-z-]+):(\S+)(?:\s+([\s\S]*))?$/.exec(src);
  if (!m) throw new Error(`a disproof is <kind>:<citation> [note], <kind> one of ${KIND_IDS}; "${clip(src, 80)}" names none`);
  const [, kind, citation] = m;
  if (!Object.hasOwn(DISPROOF_KINDS, kind)) throw new Error(`unknown disproof kind "${kind}": <kind>:<citation> takes one of ${KIND_IDS}`);
  return { kind, citation, note: clip((m[3] || "").trim(), 300), ...citationShape(kind, citation) };
}

/**
 * `--dismiss <id>=<kind>:<citation> [note]` flags as { <id>: disproof }. A malformed one, an unknown kind, a
 * wrong-shaped citation or a second dismissal of one finding is refused by name.
 */
export function parseDismissals(list) {
  const out = {};
  for (const item of list || []) {
    const m = /^(?:id:)?([0-9a-f]{10})=([\s\S]+)$/.exec(String(item).trim());
    if (!m) throw new Error(`--dismiss wants <id>=<kind>:<citation> [note], not "${item}"`);
    const id = m[1];
    if (out[id]) throw new Error(`--dismiss ${id}: one dismissal per finding, and this id is given twice`);
    try {
      out[id] = { id, ...parseDisproof(m[2]) };
    } catch (err) {
      throw new Error(`--dismiss ${id}: ${err.message}`, { cause: err });
    }
  }
  return out;
}

/**
 * The check that needs no finding: does the citation hold in this repository? `io` = { commit(sha) -> full sha | null,
 * isAncestor(a, b) -> bool, from (the reviewed range's base), fromLabel, read(path) -> text | null at the reviewed
 * revision }. A link is shape-checked only (the gate is offline) and says so. Null, or the reason it does not hold.
 */
export function verifyCitation(d, io) {
  if (d.form === "url") return null;
  if (d.form === "sha") {
    const full = io.commit(d.sha);
    if (!full) return `commit ${d.sha} does not resolve in this repository`;
    if (d.kind === "pre-existing" && !(io.from && io.isAncestor(full, io.from)))
      return `commit ${d.sha} is not before the reviewed range (${io.fromLabel || io.from || "no base"})`;
    return null;
  }
  const text = io.read(d.path);
  if (text == null) return `${d.path} is not a file at the reviewed revision`;
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/).length;
  if (d.line != null && (d.line < 1 || d.line > lines)) return `${d.path} has ${lines} line(s), so it has no line ${d.line}`;
  if (d.form === "symbol") {
    // Every segment of a dotted symbol is a whole word in the file, so `Real.bogus` does not pass on `Real` alone.
    const missing = d.symbol.split(".").find((s) => !new RegExp(`(?<![\\w$])${s.replace(/\$/g, "\\$")}(?![\\w$])`).test(text));
    if (missing) return `${missing === d.symbol ? d.symbol : `${missing} (of ${d.symbol})`} does not appear in ${d.path}`;
  }
  return null;
}

/** What review.json and the report keep of a disproof that held, and how it was checked. */
export function disproofRecord(d) {
  const checked = d.form === "url" ? "link (not fetched)" : d.form !== "sha" ? d.form : d.kind === "pre-existing" ? "blame" : "commit";
  return { kind: d.kind, citation: d.citation, note: d.note || "", checked };
}

/**
 * The check that needs the finding: null when the dismissal stands, else { code, why, escalates?, owner? }. No finding
 * by that id, an escalating finding, a critical one; and for pre-existing, a finding with no line, a line this change
 * adds, or a line git blame gives to another commit. `facts` = { added: Map<file, Map<line, text>>, blame(file, line) }.
 */
export function refuseDismissal(d, f, facts = {}, classes = {}) {
  if (!f) return { code: "no-finding", why: `no finding id:${d.id} in this review (stale or mistyped)` };
  if (f.escalates) {
    const owner = classes[f.escalates]?.owner || OWNER_UNKNOWN;
    return {
      code: "escalates",
      escalates: f.escalates,
      owner,
      why: `escalates (${f.escalates}): the judge never dismisses it alone - fix it, or take it to ${owner} or the Boardroom`,
    };
  }
  if (f.severity === "critical") return { code: "critical", why: "a critical finding cannot be suppressed or dismissed: fix it" };
  if (d.kind !== "pre-existing") return null;
  if (!f.file || f.line == null) return { code: "no-line", why: "pre-existing needs the finding's file and line; this one names none" };
  if (facts.added?.get(f.file)?.has(f.line))
    return { code: "added-line", why: `${f.file}:${f.line} is a line this change adds, so it does not predate it` };
  const blamed = facts.blame ? facts.blame(f.file, f.line) : null;
  if (!blamed || !blamed.startsWith(d.sha))
    return {
      code: "blame-mismatch",
      why: `git blame names ${blamed ? blamed.slice(0, 10) : "no commit"} for ${f.file}:${f.line}, not ${d.citation}`,
    };
  return null;
}

const DECL = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^\s*(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*(?!(?:if|for|while|switch|catch|return|function)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^\s*(?:async\s+)?def\s+(\w+)/,
  /^\s*(?:test|it|describe)\(\s*["'`]([^"'`]{1,60})/,
];
const indentOf = (s) => /^\s*/.exec(s)[0].length;
const declared = (line) => {
  for (const re of DECL) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
};

/**
 * The function a line sits in: its own declaration, else the nearest one above it at a lower indent; null outside one
 * (an object literal, a type, an import list). A scan, not a model's word, so the name is the same in every round and
 * a diff cannot steer it. A lower-indent line starting with ")" closes a multi-line signature: the declaration sits
 * above it at that indent, so the scan goes on one column in.
 */
export function enclosingFunction(text, line) {
  const lines = String(text || "").split(/\r?\n/);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  const own = declared(lines[line - 1]);
  if (own) return own;
  let want = indentOf(lines[line - 1]);
  for (let i = line - 2; i >= 0; i -= 1) {
    const l = lines[i];
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (ind < want && /^\s*\)/.test(l)) {
      want = ind + 1;
      continue;
    }
    if (ind >= want) continue;
    const name = declared(l);
    if (name) return name;
    want = ind;
    if (ind === 0) return null;
  }
  return null;
}

/** A finding's place for the round counter: `<file>#<function>`, or null when it names no function. */
export function roundKey(f) {
  return f.file && f.fn ? `${f.file}#${f.fn}` : null;
}

/**
 * The round counter (review-triage.md "Stop the loop", tester-army/e2e, Apache-2.0, ideas only). `previous` is the last
 * run's review.json (--previous) or null. A finding whose id the last run did not hold is a new edge case, and a run
 * with one on a function adds a round there. Once ROUND_CAP rounds are counted on a function, this run's new findings
 * there are residue: out of the verdict, named for the handoff. A critical or escalating finding is never residue, a
 * finding the last run already held is the same finding still open, and one with no function is never counted.
 */
export function applyRounds(live, previous = null) {
  const before = previous?.rounds && typeof previous.rounds === "object" ? previous.rounds : {};
  const seen = new Set();
  const wasResidue = new Map();
  if (previous) {
    for (const a of Object.values(previous.axes || {})) for (const f of a?.findings || []) seen.add(f.id);
    for (const f of [...(previous.dismissed || []), ...(previous.suppressed || [])]) seen.add(f.id);
    for (const f of previous.residue || []) {
      seen.add(f.id);
      wasResidue.set(f.id, f.round);
    }
  }
  const rounds = { ...before };
  const counted = new Set();
  const kept = [];
  const residue = [];
  // Residue the last run named stays residue: flagging it again does not bring it back into scope.
  for (const f of live) {
    const key = roundKey(f);
    const held = f.severity === "critical" || Boolean(f.escalates);
    const prior = Number(before[key]) || 0;
    if (key && !seen.has(f.id) && !counted.has(key)) {
      counted.add(key);
      rounds[key] = prior + 1;
    }
    if (key && !held && !seen.has(f.id) && prior >= ROUND_CAP) residue.push({ ...f, round: prior + 1 });
    else if (key && !held && wasResidue.has(f.id)) residue.push({ ...f, round: wasResidue.get(f.id) });
    else kept.push(f);
  }
  return { live: kept, residue, rounds };
}

function renderFinding(f, classes) {
  const where = f.file ? ` \`${f.file}${f.line != null ? `:${f.line}` : ""}\`` : "";
  const escalates = f.escalates ? ` escalates: ${f.escalates} (${classes?.[f.escalates]?.owner || OWNER_UNKNOWN})` : "";
  const lines = [
    `- **${f.severity}**${f.judgementCall ? " (judgement call)" : ""} [${f.category}]${where} ${f.title} \`id:${f.id}\` (${f.reviewers.join(", ")})${escalates}`,
  ];
  if (f.why) lines.push(`  ${f.why.replace(/\s+/g, " ")}`);
  if (f.specQuote) lines.push(`  spec: "${f.specQuote.replace(/\s+/g, " ")}"`);
  if (f.notes.length) lines.push(`  ${f.notes.join("; ")}`);
  return lines.join("\n");
}

const CHECKED = {
  blame: "git blame names it, before the reviewed range",
  commit: "the commit resolves",
  path: "the file is there",
  symbol: "the symbol is in that file",
};
const renderDisproof = (d) =>
  `${d.kind}: ${d.citation} (${CHECKED[d.checked] || d.checked})${d.note ? ` - "${d.note.replace(/\s+/g, " ")}"` : ""}`;

/** The Boardroom's bare-question form (boardroom.mjs usage), for an escalating finding nobody may dismiss alone. */
function boardroomLine(r) {
  // The title and the path are the model's words over an untrusted diff, and the reader pastes this into a shell.
  const quoted = (s) => String(s || "").replace(/["`$\\]/g, "'");
  const where = r.file ? `, ${quoted(r.file)}${r.line != null ? `:${r.line}` : ""}` : "";
  return `bun dredd/boardroom.mjs --room tooling "${quoted(r.title)} (id:${r.id}${where}): fix it or keep it open?"`;
}

/**
 * The report: the two axes under their own headings, never merged, each naming its worst finding first; then what was
 * dismissed with a disproof, every dismissal refused and why, and the residue a third round left out of scope.
 * `classes` names each escalating finding's owner; `escalationNote` says when the roster declares no classes.
 */
export function renderReview(result, { base, roster, classes = {}, escalationNote = "" }) {
  const out = [
    `# Code review: ${result.verdict}`,
    "",
    `Against \`${base}\`. Reviewers: ${roster.map((r) => `${r.id} (${r.why})`).join(", ") || "none"}.`,
    "",
  ];
  if (escalationNote) out.push(escalationNote, "");
  const worst = AXES.map(
    (a) =>
      `${a}: ${result.axes[a].worst ? `${result.axes[a].worst.severity} - ${result.axes[a].worst.title}` : result.axes[a].judged ? "nothing" : "not judged"}`,
  );
  out.push(`Worst per axis: ${worst.join(" · ")}`);
  const refused = result.refused || [];
  const residue = result.residue || [];
  const counts = [
    ...(refused.length ? [`Dismissals refused: ${refused.length} (see below).`] : []),
    ...(residue.length ? [`Out of scope after two rounds: ${residue.length}.`] : []),
  ];
  if (counts.length) out.push(counts.join(" "));
  out.push("");
  for (const axis of AXES) {
    const a = result.axes[axis];
    out.push(`## ${axis === "standards" ? "Standards" : "Spec"}: ${a.verdict || "not judged"}`, "");
    if (a.note) out.push(a.note, "");
    out.push(...(a.findings.length ? a.findings.map((f) => renderFinding(f, classes)) : [a.judged ? "No findings." : "-"]), "");
  }
  if (result.dismissed?.length) {
    out.push("## Dismissed with a disproof", "");
    for (const f of result.dismissed) out.push(`- ${f.title} \`id:${f.id}\` - ${renderDisproof(f.disproof)}`);
    out.push("");
  }
  if (refused.length) {
    out.push("## Dismissals refused", "");
    for (const r of refused) {
      out.push(`- \`id:${r.id}\` ${r.kind}:${r.citation} - ${r.why}`);
      if (r.code === "escalates") out.push(`  \`${boardroomLine(r)}\``);
    }
    out.push("");
  }
  if (result.suppressed.length) {
    out.push("## Suppressed by an inline ignore marker", "");
    for (const f of result.suppressed)
      out.push(`- ${f.title} \`id:${f.id}\` - ${f.disproof ? renderDisproof(f.disproof) : f.ignoredBecause}`);
    out.push("");
  }
  if (residue.length) {
    out.push("## Out of scope: a third round of edge cases on one function (name these in the handoff)", "");
    for (const f of residue) out.push(`- \`${roundKey(f)}\` round ${f.round}: ${f.title} \`id:${f.id}\``);
    out.push("");
  }
  if (result.failed.length)
    out.push(`## Did not answer (the review is incomplete)`, "", ...result.failed.map((f) => `- ${f.id}: ${f.error}`), "");
  return out.join("\n");
}

#!/usr/bin/env node
/**
 * The code-review roster - one change (a branch, a diff, what is about to land) reviewed by the specialists whose
 * paths it touches, on two axes that are never merged, and ONE verdict computed in code.
 * ==============================================================================================================
 *
 *   node dredd/review.mjs                          review the working tree against origin/main's merge base
 *   node dredd/review.mjs --base <ref>             ...against another base
 *   node dredd/review.mjs --commit <sha>           review one landed commit as itself (<sha>~1..<sha>); a docket
 *                                                        from the post-land checkpoint names its commit, and that is the default
 *   node dredd/review.mjs --spec <file>            the Spec judge reads this as what the change was asked to do
 *   node dredd/review.mjs --ask "<the ask>"        ...or this text (a docket's ask is the default spec)
 *   node dredd/review.mjs --docket <dir>           as a bench instrument: the docket's ask and root, report into it
 *   node dredd/review.mjs --roster                 who would review this change, and why; no model is asked
 *   node dredd/review.mjs --dismiss <id>=<kind>:<citation> [note]
 *                                                        dismiss one finding with its disproof, <kind> one of pre-existing,
 *                                                        misread-semantics, guaranteed, trade-off, repo-rule; the citation
 *                                                        is checked before any model is asked (exit 2 when it does not hold)
 *   node dredd/review.mjs --previous <dir|review.json>
 *                                                        the last run: rounds of new edge cases per function carry on, and a
 *                                                        third round's new findings are residue, named and out of the verdict
 *   node dredd/review.mjs --gate                   exit 3 on request_changes, an incomplete review or a refused dismissal
 *                                                        (a hook or CI can hold the merge on it)
 *   flags: --root <repo> --out <dir> --json; an unknown --flag is refused (exit 2)
 *
 * WHY: nothing in the fleet reviewed a change as a gate (2026-09-24 harvest of react-native's .expo-code-review and
 * mattpocock's code-review skill, both MIT, ideas only). The roster is dredd/reviewers/*.md, or the judged
 * repository's own .dredd/reviewers/ when it has one: ADD A REVIEWER BY ADDING A FILE. shared.md is every reviewer's
 * preamble. The Standards and Spec judges always sit; a specialist sits when one of its `@ref glob:` lines matches a
 * changed path, and is shown only those paths. The rules that decide (lib/review.mjs) are code, not prompt.
 * The findings the judge never dismisses alone (auth, a public contract, a wire schema) are the roster folder's
 * escalate.json, so a judged repository with its own .dredd/reviewers/ declares its own.
 *
 * WRITES: <out>/review.md (the two axes under their own headings), review.json (the verdict, every finding with its
 * id, what was suppressed, dismissed or refused and why, the residue and the rounds per function) and
 * review-calls.jsonl (every model call). <out> is the docket, else --out, else <root>/tmp/dredd/review-<stamp>/.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { askBrain, closeBrain } from "./lib/brain.mjs";
import { ENGINE_DIR, ENGINE_ROOT } from "./lib/docket.mjs";
import {
  ESCALATION_CLASSES,
  FINDINGS_SCHEMA,
  coordinate,
  diffFor,
  enclosingFunction,
  frontmatter,
  ignoreMarkers,
  landedPaths,
  normalizeFindings,
  parseDiff,
  parseDismissals,
  parseReviewer,
  pathMatches,
  pickRoster,
  renderReview,
  reviewRange,
  reviewerPrompt,
  verifyCitation,
} from "./lib/review.mjs";
import { isMainModule } from "../lib/shared/is-main.mjs";
import { openDocsHome } from "../lib/shared/docs-home.mjs";

export function parseArgs(argv) {
  const a = {
    base: null,
    commit: null,
    spec: null,
    ask: null,
    docket: null,
    root: null,
    out: null,
    roster: false,
    json: false,
    gate: false,
    dismiss: [],
    previous: null,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === "--roster") a.roster = true;
    else if (x === "--json") a.json = true;
    else if (x === "--gate") a.gate = true;
    else if (x === "--dismiss") {
      // The words after `<id>=<kind>:<citation>` up to the next flag are its note, quoted or not.
      let v = value(i++, x);
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) v += ` ${argv[++i]}`;
      a.dismiss.push(v);
    } else if (["--base", "--commit", "--spec", "--ask", "--docket", "--root", "--out", "--previous"].includes(x))
      a[x.slice(2)] = value(i++, x);
    else throw new Error(`unknown argument ${x}`);
  }
  return a;
}

/** The roster for a repository: its own .dredd/reviewers/ when it keeps one (its standards, its smells), else Dredd's. */
export function reviewersDirFor(root) {
  const own = path.join(root, ".dredd", "reviewers");
  return existsSync(own) ? own : path.join(ENGINE_DIR, "reviewers");
}

export function loadRoster(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "shared.md" && f !== "README.md");
  const shared = existsSync(path.join(dir, "shared.md")) ? readFileSync(path.join(dir, "shared.md"), "utf8") : "";
  return { shared, reviewers: files.sort().map((f) => parseReviewer(readFileSync(path.join(dir, f), "utf8"), f)) };
}

/** The repository's written rules for these paths: every .claude/rules/*.md whose `paths:` match one, capped. */
export function rulesFor(root, changed, max = 16000) {
  const dir = path.join(root, ".claude", "rules");
  if (!existsSync(dir)) return "";
  let out = "";
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()) {
    const text = readFileSync(path.join(dir, f), "utf8");
    const globs = frontmatter(text).meta.paths;
    if (!Array.isArray(globs) || !changed.some((p) => globs.some((g) => pathMatches(p, g)))) continue;
    out += `\n## .claude/rules/${f}\n${frontmatter(text).body.trim()}\n`;
    if (out.length > max) return `${out.slice(0, max)}\n[... rules cut at ${max} characters]`;
  }
  return out.trim();
}

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/**
 * A docs/ path when the repo's docs live only in the CrAInium (Connections since 2026-10-10, `.crainium.json`): the
 * local snapshot's text, whatever revision is reviewed, since no revision holds the docs any more; null when the
 * snapshot has no such doc or there is no snapshot. undefined for any other path, which reads from the repository.
 */
function cloudDoc(root, p) {
  const home = openDocsHome(root, { maxAgeMs: Infinity });
  if (home.home !== "cloud" || !String(p).startsWith(`${home.docsRel}/`)) return undefined;
  if (!home.snapshotDir) return null;
  const file = path.join(home.snapshotDir, p);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * What a disproof is checked against, and what names a finding's function: the repository at the reviewed revision.
 * `commit` null reads the working tree (merge-base mode); a sha reads that commit's blob through git, except an
 * installed library under node_modules/, which only the working tree has. Never throws: a git that says no is null.
 */
export function repoIo(root, { from = null, fromLabel = "", commit = null } = {}) {
  const run = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return {
    from,
    fromLabel,
    commit(sha) {
      const r = run(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
      return r.status === 0 ? r.stdout.trim() || null : null;
    },
    isAncestor(a, b) {
      return run(["merge-base", "--is-ancestor", a, b]).status === 0;
    },
    read(p) {
      const doc = cloudDoc(root, p);
      if (doc !== undefined) return doc;
      if (commit && !/(^|\/)node_modules\//.test(p)) {
        // A blob only: `git show <sha>:<dir>` prints the folder's listing and exits 0, which would pass a folder as a file.
        const r = run(["cat-file", "blob", `${commit}:${p}`]);
        return r.status === 0 ? r.stdout : null;
      }
      const abs = path.resolve(root, p);
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    blame(file, line) {
      const r = run(["blame", "-L", `${line},${line}`, "--porcelain", ...(commit ? [commit] : []), "--", file]);
      const sha = r.status === 0 ? /^([0-9a-f]{40})\b/.exec(r.stdout)?.[1] : null;
      return sha && !/^0+$/.test(sha) ? sha : null;
    },
  };
}

/**
 * The escalation classes a roster folder declares in escalate.json ({ auth, public-contract, wire-schema }, each with
 * label, owner, words, globs). None declared: the security seat alone escalates, and the note says so. An unknown class
 * or a list that is not a list of strings is refused by name.
 */
export function loadEscalation(dir) {
  const file = path.join(dir, "escalate.json");
  if (!existsSync(file)) return { classes: {}, note: `No escalate.json in ${dir}: only the security seat's findings escalate.` };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const classes = {};
  for (const [key, v] of Object.entries(raw)) {
    if (key.startsWith("$")) continue;
    if (!ESCALATION_CLASSES.includes(key))
      throw new Error(`${file}: unknown escalation class "${key}" (one of ${ESCALATION_CLASSES.join(", ")})`);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file}: ${key} must be an object`);
    for (const list of ["words", "globs"])
      if (v[list] !== undefined && !(Array.isArray(v[list]) && v[list].every((x) => typeof x === "string")))
        throw new Error(`${file}: ${key}.${list} must be a list of strings`);
    classes[key] = {
      label: String(v.label || key),
      owner: String(v.owner || "the owner of that lane"),
      words: (v.words || []).map((w) => w.toLowerCase()),
      globs: v.globs || [],
    };
  }
  return { classes, note: "" };
}

/** The last run's review.json for --previous: a folder means its review.json. Anything else is refused by name. */
export function readPrevious(p) {
  const file = existsSync(p) && statSync(p).isDirectory() ? path.join(p, "review.json") : p;
  if (!existsSync(file)) throw new Error(`--previous ${p}: no review.json there`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  if (!rec || typeof rec !== "object" || !rec.axes) throw new Error(`--previous ${p}: not a review.json (it has no axes)`);
  return rec;
}

/**
 * The exit code: 1 when every reviewer failed (no review at all); under --gate, 3 on request_changes, an incomplete
 * review or a refused dismissal (a change must not land because its security reviewer timed out, or past a dismissal
 * the judge would not take); else 0.
 */
export function exitCode(result, { gate = false, rosterSize = 0 } = {}) {
  if (rosterSize && result.failed.length === rosterSize) return 1;
  return gate && (result.verdict === "request_changes" || result.incomplete || result.refused?.length) ? 3 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docket = args.docket ? JSON.parse(readFileSync(path.join(args.docket, "docket.json"), "utf8")) : null;
  const root = path.resolve(args.root || docket?.root || ENGINE_ROOT);
  const spec = args.spec ? readFileSync(args.spec, "utf8") : args.ask || docket?.ask || "";
  const specIsAsk = !args.spec && !args.ask && Boolean(docket?.ask);
  const range = reviewRange({ base: args.base, commit: args.commit, ask: docket?.ask });
  const diff = git(root, ["diff", ...range.args, "--no-color", "--unified=3"]);
  const sections = parseDiff(diff);
  const changed = sections.map((s) => s.path).filter(Boolean);
  // A diff that holds none of the paths the docket says landed reviewed the wrong change: refuse, never approve it.
  const named = landedPaths(docket?.ask);
  if (named.length && !named.some((p) => changed.includes(p)))
    throw new Error(
      `the diff against ${range.label} holds none of the landed paths (${named.join(", ")}): nothing was reviewed, so nothing is approved`,
    );
  const dir = reviewersDirFor(root);
  const { shared, reviewers } = loadRoster(dir);
  const { classes, note: escalationNote } = loadEscalation(dir);
  // No spec, no Spec judge: an axis with nothing to measure against is reported as not judged, never as clean.
  const roster = pickRoster(reviewers, changed).filter((r) => r.axis !== "spec" || spec.trim());
  const previous = args.previous ? readPrevious(args.previous) : null;

  // Every dismissal's citation is checked against the repository before any model is asked, and ahead of --roster's
  // return, so a dismissal that cites nothing real costs nothing and is refused by name (exit 2).
  const from = range.from || git(root, ["merge-base", "HEAD", args.base || "origin/main"]).trim();
  const io = repoIo(root, { from, fromLabel: range.label, commit: range.commit });
  const dismissals = parseDismissals(args.dismiss);
  for (const [id, d] of Object.entries(dismissals)) {
    const why = verifyCitation(d, io);
    if (why) throw new Error(`--dismiss ${id}=${d.kind}:${d.citation}: ${why}`);
  }
  // A marker is the author's text in the change, not an operator's request: one that does not check out suppresses
  // nothing (its finding stays live with the reason) and never changes the exit code.
  const markers = ignoreMarkers(sections).map((m) => {
    const error = m.disproof ? verifyCitation(m.disproof, io) : null;
    return error ? { ...m, error } : m;
  });

  if (args.roster) {
    const lines = roster.map((r) => `${r.id.padEnd(20)} ${r.axis.padEnd(10)} ${r.why}`);
    process.stdout.write(`${changed.length} changed path(s) against ${range.label}\n${lines.join("\n") || "nobody: nothing changed"}\n`);
    return 0;
  }

  const out = args.docket || args.out || path.join(root, "tmp", "dredd", `review-${Date.now().toString(36)}`);
  mkdirSync(out, { recursive: true });
  const callsLog = path.join(out, "review-calls.jsonl");
  const rules = rulesFor(root, changed);
  const reports = [];
  const failed = [];
  if (changed.length) {
    const answers = await Promise.all(
      roster.map((r) => {
        const { system, prompt } = reviewerPrompt(r, { shared, diff: diffFor(sections, r.paths), spec, rules, specIsAsk });
        return askBrain({ system, prompt, schema: FINDINGS_SCHEMA, maxTokens: 2400, timeoutS: 150 }, callsLog);
      }),
    );
    closeBrain();
    // The function each finding sits in, by a scan of the file at the reviewed revision: the round counter's key.
    const texts = new Map();
    const textOf = (file) => {
      if (!texts.has(file)) texts.set(file, io.read(file) ?? "");
      return texts.get(file);
    };
    roster.forEach((r, i) => {
      const res = answers[i];
      if (res.status === "ok" && res.data) {
        const findings = normalizeFindings(r, res.data, r.paths, classes);
        for (const f of findings) f.fn = f.file && f.line ? enclosingFunction(textOf(f.file), f.line) : null;
        reports.push({ reviewer: r, findings });
      } else failed.push({ id: r.id, error: res.error || res.status });
    });
  }
  const result = coordinate({
    reports,
    markers,
    dismissals,
    facts: { added: new Map(sections.map((s) => [s.path, s.added])), blame: io.blame },
    classes,
    previous,
    failed,
    specGiven: Boolean(spec.trim()),
  });
  const record = { base: range.label, root, changed, roster: roster.map(({ id, axis, why }) => ({ id, axis, why })), ...result };
  // An empty diff is no review at all, so it never files "approve": that reads exactly like a clean review.
  if (!changed.length) record.verdict = "nothing_reviewed";
  writeFileSync(path.join(out, "review.json"), `${JSON.stringify(record, null, 2)}\n`);
  const md = changed.length
    ? renderReview(result, { base: range.label, roster, classes, escalationNote })
    : `# Code review: nothing reviewed\n\nNothing changed against \`${range.label}\`, so nothing was reviewed and nothing is approved.\n`;
  writeFileSync(path.join(out, "review.md"), md);
  process.stdout.write(args.json ? `${JSON.stringify(record, null, 2)}\n` : `${md}\n(written to ${path.join(out, "review.md")})\n`);
  return exitCode(result, { gate: args.gate, rosterSize: roster.length });
}

// Run only as the program, so the tests can import parseArgs and the loaders without asking any model.
if (isMainModule(import.meta.url))
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      closeBrain();
      process.stderr.write(`review: ${err.message}
`);
      process.exitCode = 2;
    },
  );

// dredd/lib/docket.mjs - the judge's reasoning, pure: bench + ask + answers -> a docket.
//
// Nothing in here spawns, reads the network or writes a file, so the whole decision is unit-tested
// (dredd/tests/docket.spec.mjs) without Jev, the MCP or a browser. dredd.mjs is the plumbing
// around this: it fetches the answers (Jev through HSwarm, or the keyword heuristic when Jev is
// unreachable), hands them here, then recalls memories, reads the boards and convenes.
//
// THE FOUR STANDING QUESTIONS, then one per instrument (its `jev` line in bench.json):
//   ask_class   what kind of ask this is - a complaint, a review, a decision, a build, a question
//   domain      what it is mainly about - copy, visual, flow, code, infra, cross_repo, product, data, security, money
//   scope       how big a hearing it deserves - quick look / focused review / full tribunal
//   delegation  which tier does the bulk of the work - hswarm / opus_lean / flagship / mixed
// Every question is TYPED (a closed set of options), which is exactly what Jev answers well (85.8%
// on 465 typed items, calibrated; the zswarm repo's 2026-09-21 Jev bench) and exactly what a
// generative model is wasted on. Arithmetic, dates and free text never go to Jev; nothing here asks for them.
import { loadTarget, targetPath, targetRoot } from "../../lib/target.mjs";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreText } from "./ballot.mjs";
import { bugFor, bugLines } from "./bug.mjs";
import { renderConnections } from "./catalog.mjs";
import { matterFor, renderLadder } from "./ladder.mjs";
import { pricecheckCli } from "./price.mjs";
import { filtersKeepingHome, homeLine, PAGE_OR_PRODUCT_DOMAINS, scoreStage } from "./pipeline.mjs";
import { localSharedPath } from "./shared-root.mjs";

/** Where the engine lives (dredd) and the repository it ships in - the bench, the seats and the runners
 *  under dredd resolve here whatever `--root` names. */
export const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE_ROOT = path.resolve(ENGINE_DIR, "..");

/** Do two paths name the same folder? Windows paths are case-insensitive and path.resolve keeps the caller's case, so
 *  `--root d:/newprojects/shared/connections` used to be judged as a foreign repository (2026-09-22). */
export function samePath(a, b, { platform = process.platform } = {}) {
  const x = path.resolve(String(a));
  const y = path.resolve(String(b));
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** An ask about attention, boredom, drop-off or coming back. It sends visitors (`visitorsAsked`), SUE's two critics
 *  beside them (lib/convene.mjs criticsFor), and the minds into the room's pool (lib/seats.mjs roomsHeard). */
export const RETENTION_ASK =
  /\b(?:retention|retain|drop[- ]?offs?|drops? off|dropping off|churn|bor(?:ed|ing|edom)|attention|engag(?:e|ed|ing|ement)|hooks?|hooked|dopamine|look(?:s|ed|ing)? away|come back|coming back|lose (?:them|people|users|players|interest)|losing (?:them|people|users|players|interest)|not fun|addictive|sticky|stickiness)\b/i;

export const ASK_CLASSES = {
  complaint:
    "something that EXISTS is wrong, bad, ugly, confusing, broken or too long - including when they tell you to fix it, redo it, or do all of it",
  review: "judge, critique, score or give an opinion on something that exists",
  decision: "choose between options, or say whether to do something",
  build: "make something NEW that does not exist yet - a feature, a page, a script, an integration",
  question: "a factual how / where / what / why question",
};

export const DOMAINS = {
  copy: "words - wording, headlines, length, tone, how a page or email reads",
  visual: "how something looks - layout, spacing, density, colour, components",
  flow: "a multi-step task a visitor performs - sign up, sign in, check out, host, delete",
  code: "source code - a bug, quality, tests, a refactor, implementing a feature, where something lives or is persisted in the codebase, a tool or script of ours",
  infra: "AWS resources and accounts, deploys, DNS, certificates, whether a host is up",
  cross_repo:
    "a DIFFERENT product or repository of ours named by name (SageThumbs, LunarWerx, QuickDictate, Odin...), the fleet, versions, staleness",
  product: "strategy - whether to build or cut something, pricing, positioning, competition, conversion (not how to implement it)",
  data: "tables, schema, migrations, queries, indexes, memory storage, what the fleet remembers (the memory lane, memories about a thing)",
  security: "auth, tokens, exposure, permissions, injection",
  money:
    "what WE spend in dollars - the AWS bill, credits, budgets, a forecast or month-end projection, cost by account, service or feature, AI model and token spend (not what we charge our customers, not a Claude or Codex account's quota)",
};

export const SCOPES = [
  "quick look - one instrument, an answer in a minute",
  "focused review - two to four instruments on the named thing",
  "full tribunal - every relevant instrument, including the slow field ones (simulated visitors, a full screenshot capture)",
];

export const DELEGATION = {
  hswarm:
    "the bulk is many delegated subtasks (research, code, review, judgment, mechanical per-item sweeps) - every one goes through HSwarm; desktop Opus 5.5 orchestrates and final-decides",
  opus_lean:
    "ONLY an explicit access/capability fallback after every suitable HSwarm route is exhausted - a desktop Opus 5.5 or Sonnet 5.5 sub-agent with a recorded why-not-hswarm reason (the concrete access or capability gap)",
  flagship:
    "the desktop Opus 5.5 does the final synthesis and owner-facing decision itself; no desktop workers - any delegated subtask still goes through HSwarm",
  mixed:
    "desktop Opus 5.5 orchestrates and final-decides while HSwarm does ALL delegated subtasks underneath (research, code, review, judgment, per-item sweeps)",
};

/** The delegation backend policy every docket carries (skill hswarm-routing since ZSwarm retired, 2026-10-03). */
export const DELEGATION_POLICY = {
  backend: "hswarm",
  orchestrator: "claude-opus-5-5",
  selection: "published-benchmarks",
  fallback:
    "Try other capable and then stronger Swarm configurations on quota/credit failure; desktop only for documented unavailable capability/access",
  policy: "skill hswarm-routing",
};

// The tier an INSTRUMENT names for itself (bench.json `tier`), whatever DELEGATION says about the bulk of the work.
// Dredd decides the model; there is no hourly cap behind it any more (Owner, 2026-09-23: "delete the entire limit for
// both of us ... make it so a part of Dredd says which models you should use"). SUE is the one elevated instrument
// (the key `elevated` stays, bench.json tiers name it). 2026-09-23 put her on Opus 5.5; Owner, 2026-10-05 REPLACED
// that: "spin up the Sues moving forward as Sonnet 5.5, not Opus". Everything else generally still uses the zswarm.
// When the account is short, fewer Sues, never Haiku or a pool model.
export const INSTRUMENT_TIERS = {
  elevated: {
    model: "claude-sonnet-5-5",
    agent: "sonnet",
    label: "Sonnet 5.5, the SUE tier",
    why: 'each Sue is one agent of this chat\'s own on Sonnet 5.5 (Agent model "sonnet"; owner, 2026-10-05), never Haiku or a pool model. Check the account first (check_my_usage); if it cannot take the run, send fewer Sues. This is an access exception (why-not-hswarm: the local MCP access Sue runs through), not a price-based exemption; everything else delegated goes through HSwarm',
  },
};

/** The convened instruments that name their own tier, in convene order: [{ id, tier, model, agent, label, why }]. */
export function modelsFor(convene, bench) {
  const byId = new Map(bench.instruments.map((i) => [i.id, i]));
  return convene
    .map((c) => ({ id: c.id, tier: byId.get(c.id)?.tier }))
    .filter((m) => INSTRUMENT_TIERS[m.tier])
    .map((m) => ({ ...m, ...INSTRUMENT_TIERS[m.tier] }));
}

/**
 * The p an instrument's yes must reach to be convened, by scope. A field instrument (phase 3: simulated visitors, a
 * full capture) is the slow, costly kind, so its bar is higher. A quick look (scope 0) convenes at most one
 * instrument. One object so the eval can measure a setting against the gold asks instead of guessing (eval.mjs).
 * Set 2026-09-22 by a sweep over the 39 gold asks (one cached Jev answer set, and the keyword heuristic), keeping
 * every setting that convened no instrument the gold forbids: full 0.6 -> 0.5, focused 0.75 -> 0.6, the focused field
 * bar 0.9 -> 0.75 took the exactly-right dockets from 25 to 30 on Jev (must-convene 31 -> 36 of 44) and from 22 to 25
 * on the keywords, with the must-not tally unchanged (83 of 85) on both.
 * Re-swept 2026-09-23 with `eval.mjs --replay --bars` over one saved Jev answer set, after four rule fixes (a decision is
 * at least focused, a quick look may add a session skill, an empty docket seats its specialist, the Atlas is not a
 * page visitor, rungs two and four are page rungs): focused 0.6 -> 0.55 and the focused field bar 0.75 -> 0.7 took
 * exactly-right dockets from 30 to 40 of 41 on Jev (must-convene 34 -> 42 of 44, any-of 4 -> 6 of 6) with must-not
 * 94 -> 96 of 96; the keywords went 27 -> 28 with must-not unchanged (94 of 96).
 * Re-swept 2026-09-23 (the Dredd self-pass) over all five saved Jev answer sets of that evening: the focused field bar
 * 0.7 -> 0.65 was never worse and better on four (50->51, 52->53, 52->53, 53->54; one set already 55/55), must-not
 * unchanged on every set. The one ask it moved, every time: "signup keeps dead-ending, people just give up" sat SUE at
 * 0.68.
 */
export const BARS = { full: 0.5, focused: 0.55, focusedField: 0.65, quick: 0.75, quickField: 0.85 };

/** The words that ASK for the room on a code matter, where the Architect otherwise rules alone. */
export const ROOM_ASKED_RX =
  /\b(?:board ?room|the (?:board|room|critics)|critics|argue|debate|what (?:does|would) the room|second opinion|opinions?)\b/i;

/** The shape the Chair named the whole judge for: 'sometimes the AI may not know which tool to call'. */
export const WHICH_TOOL_RX =
  /\b(?:is there (?:a|any|some) (?:tool|check|script|instrument|skill)|which (?:tool|instrument|check|script|skill)s?\b|what (?:tool|instrument|check|script|skill)s? (?:do|should|can|could) (?:we|i|you)|do we (?:have|own) (?:a|any|some)(?:thing)? (?:tool|check|script|instrument|skill|way)|what do we have (?:for|that)|how do (?:we|i) (?:check|measure|test|audit) (?:for|whether|if))\b/i;

/** The prompt hook's gate (.claude/hooks/dredd-docket.mjs imports these; one copy, 2026-09-22 - the hook's own copy of
 *  the which-tool shape had drifted and missed "which tools", "is there any tool" and "what do we have that"). The two
 *  below are deliberately NARROWER than CLASS_RX: the hook costs a Jev call per firing, and CLASS_RX's complaint and
 *  review words (rate, score, look at, wrong, blank, busy) fire on ordinary prompts. */
export const HOOK_GRIEVANCE_RX =
  /\b(sucks?|bloated|verbose|wordy|ugly|hideous|confus\w*|broken|terrible|awful|hate|cramped|clutter\w*|too (?:long|much|many|wordy|busy|small|big)|doesn'?t (?:work|make sense|look)|not (?:working|right|good)|looks? (?:off|wrong|bad|weird|like shit)|nobody (?:knows|understands|signs)|no one (?:knows|understands|signs)|(?:it'?s|this is|that'?s) (?:wrong|bad|broken|garbage|trash))\b/i;
export const HOOK_REVIEW_RX =
  /\b(review|critique|judge|verdict|opinion|what do you think|rate (?:this|the|it)|score (?:this|the|it)|is this (?:good|right|ok|fine)|thoughts on|tear (?:this|it) apart|roast)\b/i;

/** An ask that TOUCHES AWS (the Chair, 2026-09-23: "make sure Dredd also manages things like the AWS Atlas - in case
 *  something touches, reads, or needs access to AWS"). Which identity reaches it comes before the work, because a read
 *  under the wrong account comes back empty or AccessDenied rather than failing loudly - so the docket convenes the
 *  Atlas's `access` instrument (`atlas:who`) first. Named AWS nouns and actions, never a bare "deploy" or "logs": the
 *  hook costs a Jev call and a few seconds per firing, and local build logs are not AWS. */
export const HOOK_AWS_RX =
  /\b(?:aws|rds[ -]data(?: api)?|s3 bucket|(?:query|hit|read|touch|access) (?:the )?prod(?:uction)?|prod(?:uction)? (?:db|database|data)|lambda_deploy_zip|logs_tail|cdk (?:deploy|diff|synth)|deploy (?:the |a |an |our )?(?:[\w-]+ )?(?:lambda|stack|plane|function|fleet)s?|lambda logs?|log groups?|cloudwatch|parameter store|secrets manager|assumed? role|vault instance|which aws account|what aws account|which account do (?:i|we) use|which (?:vault )?instance|co-?tenants?|(?:run|apply) (?:the |a )?migrations?)\b/i;

/** A DECISION in the owner's words (the Chair, 2026-09-23: Dredd "wired in to be run occasionally over things to help make
 *  decisions"). DREDD.md's "When" has promised the hook fires on "should we cut the second pricing card" since the
 *  judge was built, and no gate matched it. Named choices only - "should we" with a PRODUCT verb (cut, keep, ship,
 *  build, price, launch, retire...), "which is better", "X or Y" framed as a pick - never a bare "should", which is in
 *  half of all prompts ("should I run the tests?"), and never the code verbs (add, remove, move, rename, merge, split,
 *  replace, switch): "should I remove this import" is a coding step, not a decision for the judge (its own review). */
export const HOOK_DECISION_RX =
  /\b(?:should (?:we|i) (?:cut|keep|drop|kill|ship|build|go with|pick|choose|price|charge|launch|retire|sunset|pivot|bundle|unbundle|offer|start (?:charging|offering|selling))|(?:which|what) (?:one|option|approach|version|variant|design|layout|plan|name|price|tier) (?:is better|should (?:we|i)|do (?:we|i) (?:pick|choose|go with))|which is better|(?:pick|choose|decide) between|is it worth (?:it|doing|building|keeping|the)|worth (?:building|keeping|cutting)\?|keep (?:it )?or (?:cut|kill|drop) (?:it)?|trade-?offs? (?:between|of (?:doing|going))|go with (?:option )?[ab12]\b|(?:option|plan) [ab12] or (?:option |plan )?[ab12]\b)/i;

/** Is this prompt a grievance, a review, a which-tool question, a decision or an AWS touch - the shapes the hook fires Dredd on? */
export function promptWantsDredd(prompt) {
  const text = String(prompt || "");
  return (
    HOOK_GRIEVANCE_RX.test(text) ||
    HOOK_REVIEW_RX.test(text) ||
    WHICH_TOOL_RX.test(text) ||
    HOOK_DECISION_RX.test(text) ||
    HOOK_AWS_RX.test(text)
  );
}

/**
 * The bench for a repository. Connections' own bench is the engine's `bench.json`; another repository
 * (`--root <repo>`, the Chair 2026-09-22: "I'll be able to run this on multiple code bases") brings its own
 * `<repo>/.dredd/bench.json` when it has one, and otherwise gets this bench minus every instrument that
 * repository cannot run (the SUE cannon, the Architect's checks, the wave - anything whose runner is a file
 * of THIS checkout). `bench.filtered` records what was dropped and why, so the docket can say so.
 */
export function loadBench(root, { engineDir = ENGINE_DIR } = {}) {
  const own = path.join(root, ".dredd", "bench.json");
  const file = existsSync(own) ? own : path.join(engineDir, "bench.json");
  const bench = JSON.parse(readFileSync(file, "utf8"));
  const ids = new Set();
  for (const inst of bench.instruments) {
    if (ids.has(inst.id)) throw new Error(`bench.json: duplicate instrument id ${inst.id}`);
    ids.add(inst.id);
    // An instance is carried by the local MCP's shell, which refuses to take credentials into a detached run, so an
    // instrument that declares one must run "now" or it would quietly run with none (convene.mjs runInstrument).
    if (inst.instance && inst.mode !== "now")
      throw new Error(`bench.json: ${inst.id} declares instance ${inst.instance}, so its mode must be "now", not "${inst.mode}"`);
  }
  bench.file = file;
  bench.all = bench.instruments;
  const engineRoot = path.resolve(engineDir, "..");
  if (file !== own && !samePath(root, engineRoot) && !samePath(root, targetRoot())) {
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts || {};
    } catch {
      /* no package.json: no package scripts */
    }
    const kept = [];
    const filtered = [];
    for (const inst of bench.instruments) {
      const v = runnableIn(inst, { root, engineRoot, scripts, exists: existsSync });
      if (v.ok) kept.push(inst);
      else filtered.push({ id: inst.id, why: v.why });
    }
    bench.instruments = kept;
    bench.filtered = filtered;
  }
  return bench;
}

/**
 * The member roster for a repository: the engine's own `member-bench.json`, or another repository's
 * `<repo>/.dredd/member-bench.json` when it has one - `loadBench`'s door, for the member-facing capabilities instead of
 * the instruments. Each row carries one yes/no `jev` question, the `keywords` that answer it without Jev, and the
 * exact `setting` a member's question about it is really about.
 */
export function loadMemberBench(root, { engineDir = ENGINE_DIR } = {}) {
  const own = path.join(root, ".dredd", "member-bench.json");
  const file = existsSync(own) ? own : path.join(engineDir, "member-bench.json");
  const roster = JSON.parse(readFileSync(file, "utf8"));
  roster.file = file;
  return roster;
}

/** The file a `node|bun|python` run line names, its runtime flags skipped: `node --experimental-strip-types x.mjs` names
 *  x.mjs, not the flag (the doctor called flow-walk MISSING over exactly that, 2026-09-23). null when no file is named. */
export function runLineFile(run) {
  return /^(?:node|bun|python)(?:\s+-\S+)*\s+(?!-)(\S+)/.exec(String(run || ""))?.[1] ?? null;
}

/**
 * Can `root` run this instrument? Pure given `exists`. A runner under dredd is the engine's and runs
 * anywhere; `bun run <script>` needs the script in root's package.json; any other repo-relative file named
 * first on the run line must exist under root; an absolute or home path is the machine's, not the repo's;
 * agent and always instruments name a call, not a file, and travel. A runner named under `{connections}` runs from the
 * engine's checkout wherever the hearing is (page-pulse, and SUE, who needs nothing of the judged repo but its URL).
 * An instrument with `anyPage` has a way to judge a page it cannot run its own runner for (the Design Critic scores
 * page-pulse's photographs of it), so it stays on another repository's bench as long as the engine carries it.
 */
export function runnableIn(inst, { root, engineRoot, scripts = {}, exists }) {
  if (inst.mode === "agent" || inst.mode === "always") return { ok: true, why: "names a call, not a file" };
  const run = String(inst.run || "");
  const script = /^bun run (\S+)/.exec(run);
  if (script)
    return scripts[script[1]]
      ? { ok: true, why: `package script ${script[1]}` }
      : { ok: false, why: `no package script ${script[1]} in ${root}` };
  const file = runLineFile(run);
  if (!file) return { ok: true, why: "not a file runner" };
  if (file.startsWith("{dredd}")) return { ok: true, why: "the engine's own runner" };
  if (file.startsWith("{sue}")) return { ok: true, why: "the engine's checkout SUE runner" };
  if (/^\{(?:connections|pagePulseRunner|arkitectCli|codeGateRunner)\}/.test(file)) return { ok: true, why: "a runner in the configured Connections target checkout" };
  if (file.startsWith("{pricecheckCli}")) return { ok: true, why: "the pricecheck CLI on this machine, scoring the judged repo" };
  if (/^[A-Za-z]:[\\/]|^\/|^%USERPROFILE%|^~/.test(file)) return { ok: true, why: "a machine path" };
  const rel = file.replace(/\\/g, "/");
  if (exists(path.join(root, rel))) return { ok: true, why: "runner present" };
  const engines = exists(path.join(engineRoot, rel));
  if (inst.anyPage && engines) return { ok: true, why: `any page: ${inst.anyPage}` };
  return { ok: false, why: `${rel} is not in ${root}${engines ? " (it is a Connections instrument)" : ""}` };
}

/** The runner file a run line names on THIS machine's disk (an absolute or home path) when it is not there, else null.
 *  runnableIn passes a machine path unchecked because it is the machine's business, not the repo's; the doctor lists a
 *  missing one, but the docket used to print its command anyway (Odin, first on the list, on a PC that never cloned
 *  it, 2026-09-25). The render names the gap under the instrument so the reader skips it instead of running it. */
export function missingMachineRunner(run, { engineRoot = ENGINE_ROOT, exists = existsSync, home = os.homedir() } = {}) {
  const file = runLineFile(run);
  if (!file || !/^[A-Za-z]:[\\/]|^\/|^%USERPROFILE%|^~/.test(file)) return null;
  const expanded = file.replace(/^(?:%USERPROFILE%|~)/, home.replace(/\\/g, "/"));
  const local = localSharedPath(expanded, { engineRoot });
  return exists(local) ? null : local;
}

/** A page named in the ask: a full URL, or a bare hostname of ours ("app.example.com", "example.com/pricing") -
 *  people name pages the way they say them, and a named page is what puts page-pulse and SUE on the docket. */
export function extractUrl(ask) {
  const text = String(ask || "");
  const m = /https?:\/\/[^\s)"'<>]+/i.exec(text);
  const bare = m ? null : /(?:^|[\s("'])((?:[a-z0-9-]+\.)*connections\.icu(?:\/[^\s)"'<>]*)?)/i.exec(text);
  const found = m ? m[0] : bare ? bare[1] : null;
  if (!found) return null;
  // Words in an ask that only LOOK like a page (an unparseable host) name no page, so the ask simply has none.
  try {
    return normalizeUrl(found.replace(/[.,;:]+$/, ""));
  } catch {
    return null;
  }
}

/**
 * The one shape a page URL takes inside Dredd: parsed, http or https only, and `URL.href` (so a space or a quote is
 * percent-encoded before any instrument sees it). A bare host gets https://, a bare localhost or 127.0.0.1 gets
 * http://. Throws with a plain reason on anything else. `--url` goes through this at the door (2026-09-22): a bare
 * `example.com/pricing` used to reach the convene as typed and throw "Invalid URL" halfway, after page-pulse had run.
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("the page URL is empty");
  // A scheme is a word and a colon NOT followed by a digit (`localhost:4173` is a host and a port). Checked before
  // prefixing, or `mailto:a@b.c` would become https://mailto:a@b.c, a valid URL with a user name in it.
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)
    ? text
    : `${/^(?:localhost|127\.0\.0\.1)(?:[:/]|$)/i.test(text) ? "http" : "https"}://${text}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`"${text}" is not a page URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`"${text}" is a ${u.protocol} URL; Dredd judges http and https pages only`);
  return u.href;
}

const STOP = new Set(
  "the a an and or but of to in on at for with from by is are was were be been being this that these those it its our we you your they them their i me my he she his her as if so than then too very just not no yes do does did done have has had can could should would will shall may might must about into over under out up down off again more most some any all each every both few own same other such only very".split(
    " ",
  ),
);

/** Repository paths the ask names - a file, a directory, a tool - so the code gate has something to run on. Pure: existence is the caller's check. */
export function extractPaths(ask) {
  const out = new Set();
  // A URL's path is not a repository path: drop every URL before looking.
  const text = String(ask || "").replace(/https?:\/\/\S+/g, " ");
  for (const m of text.matchAll(
    /(?<![\w@:/])((?:[\w.@-]+\/)+[\w.@-]+\/?|[\w.-]+\.(?:mjs|cjs|js|ts|tsx|vue|py|json|md|sql|ps1|sh|yml|yaml)|(?:sue|dredd))(?![\w/])/g,
  )) {
    const p = m[1].replace(/\/$/, "").replace(/[.,;:]+$/, "");
    if (/^https?:/.test(p) || p.startsWith("node_modules") || p.length < 3) continue;
    out.add(p);
  }
  return [...out];
}

/** Extensions of files that are code rather than a page, its styles or a document. */
const CODE_EXT_RX = /\.(?:mjs|cjs|js|ts|py|sql|ps1|sh)$/i;
/** Folders that hold code no page renders: the tools, scripts, runners, hooks, packages, infra and plane back ends. */
const CODE_DIR_RX =
  /^(?:sue|dredd|tools|scripts|\.arkitect|\.claude|packages|infra)(?:\/|$)|^services\/[\w-]+\/(?:lambda|api|infra|local-mcp)(?:\/|$)/;

/**
 * Whether a named repository path is code: a file by its extension (a `.vue` page, a stylesheet, a doc or an HTML page is
 * not), a folder by where it lives. Pure.
 */
export function isCodePath(p) {
  const rel = String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (/\.[A-Za-z0-9]+$/.test(rel.split("/").pop() || "")) return CODE_EXT_RX.test(rel);
  return CODE_DIR_RX.test(rel);
}

/** The nouns worth searching on - what recall, Odin and the copy checks are pointed at. A wrapper tag the client puts
 *  around a paste (`<pasted_content id="d210">`) is markup, not the ask: recall keyed on "pasted" and "content" and
 *  printed five other products' memories into a docket that convened nothing (docket 20260925-175132-245a; chat
 *  4addbcc6's rating, 2026-09-24). */
export function keyTerms(ask, limit = 6) {
  const words = String(ask || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/g, " ")
    .split(/[^a-z0-9][^a-z0-9]*/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

/** The typed questions for one ask: the four standing ones plus one per instrument that has a `jev` line. */
export function buildQuestions(bench, ask, { url = null } = {}) {
  const state = url ? `${ask}\n\n(The page in question: ${url})` : ask;
  const items = [
    { id: "ask_class", state, type: "choice", question: "What kind of ask is this?", options: ASK_CLASSES },
    { id: "domain", state, type: "choice", question: "What is this mainly about?", options: DOMAINS },
    {
      id: "scope",
      state,
      type: "score",
      question:
        "How big a hearing does this deserve? A short passing remark about one thing is a quick look. A complaint or review of one named page, email or feature is a focused review. 'Do all of it', 'everything', 'thorough', 'tear it apart', or a complaint that people do not understand the product at all is a full tribunal.",
      options: SCOPES,
    },
    {
      id: "delegation",
      state,
      type: "choice",
      question:
        "Which tier shape fits the work this ask leads to? Whatever the answer, ALL delegated subtasks (research, code, review, judgment) go through HSwarm and the desktop Opus 5.5 orchestrates and final-decides. hswarm when the bulk is many delegated subtasks; flagship when the core is the desktop's own final synthesis or owner-facing decision (never desktop workers); mixed when a desktop judgment sits on top of HSwarm subtasks; opus_lean ONLY when a documented access/capability gap remains after every suitable HSwarm route is exhausted (a why-not-hswarm reason is required) - never for price or convenience.",
      options: DELEGATION,
    },
  ];
  for (const inst of bench.instruments) {
    if (!inst.jev) continue;
    items.push({ id: `inst:${inst.id}`, state, type: "yesno", question: inst.jev });
  }
  return items;
}

const CLASS_RX = {
  complaint:
    /\b(sucks?|fucked|bloated|verbose|wordy|ugly|confus\w*|broken|blank|wrong|terrible|awful|hate|hideous|cramped|busy|clutter\w*|clunky|annoy\w*|frustrat\w*|fights? (?:me|us|them)|unpolished|janky|not (?:polished|professional)|looks? (?:cheap|dated|amateur|unfinished|unprofessional)|overwhelm\w*|progressive disclosure|nobody\b|no one\b|can'?t tell|what we (?:sell|do|are)|too (?:long|much|many|wordy|busy|small|big)|doesn'?t (?:work|make sense|look)|not (?:working|right|good)|looks? (?:off|wrong|bad|weird|like shit)|nobody (?:knows|understands)|no one (?:knows|understands))\b/i,
  review:
    // An ask that cites how something was rated (a score, stars, a re-test after one) is asking for it to be judged
    // again: a review, however it is phrased (2026-10-02: a re-test after visitors "all gave two stars" read as a question).
    /\b(review|critique|judge|verdict|opinion|what do you think|rate[ds]?|rating|scored?|stars?|out of (?:five|ten|\d+)|re-?test(?:ed|ing)?|is this (?:good|right|ok|fine)|thoughts on|look at|biggest problem|feels? (?:off|wrong|weird)|what'?s (?:off|wrong)|polish(?:ed|es|ing)?)\b/i,
  decision: /\b(should (?:we|i)|which (?:one|of|tool|model|way)|or should|decide|choose|pick|go with|worth it)\b/i,
  build: /\b(build|add|create|implement|make (?:me|us|a|an|the)|write (?:me|a|an|the)|ship|wire|integrate|migrate|refactor|fix)\b/i,
  question:
    /\b(how (?:do|does|did|is|are|many|much)|where (?:is|are|does|do)|what (?:is|are|does|do)|why (?:is|are|does|do|did)|is there|are there|can (?:we|i|you))\b/i,
};

/**
 * How many of `words` the text names. A keyword that ends in a letter or digit is a whole word plus its common
 * inflections (deploy -> deploys, deployed, deploying), never a bare prefix: prefix matching fired "repo" on
 * "report", "cert" on "certainly" and "plan" on "plane" (2026-09-22). A keyword ending in punctuation ("tools/")
 * stays a prefix, and a deliberate stem says so with a trailing "*" ("vulnerab*").
 */
export function countHits(text, words) {
  let n = 0;
  for (const w of words) {
    if (!w) continue;
    const stem = w.endsWith("*");
    const word = stem ? w.slice(0, -1) : w;
    const body = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const tail = stem ? "" : /[a-z0-9]$/i.test(word) ? "(?:s|es|d|ed|ing|er|ers)?(?![a-z0-9])" : "";
    if (new RegExp(`\\b${body}${tail}`, "i").test(text)) n += 1;
  }
  return n;
}

/**
 * "down" as the particle of another verb ("tear down altahq.com", "break down what gong does", "narrow it down") is
 * not a host that is down: "Tear down altahq.com ... find every feature worth adding" scored infra through the infra
 * lane's "down" and convened the AWS Atlas for a competitor teardown (Owner, 2026-09-24). The keyword pass reads such a
 * phrase as one word ("teardown"), which the product lane names; "the site went down" still scores infra.
 */
const PARTICLE_DOWN_RX =
  /\b(tear|tears|tearing|tore|torn|break|breaks|breaking|write|writes|writing|narrow|narrowing|boil|boils|boiling|water|watered|dumb|dumbed|pin|track|hunt|jot|slim|trim|pare|pared)(\s+(?:it|them|this|that|these|those)\b)?\s+down\b/gi;
export const keywordText = (ask) => String(ask || "").replace(PARTICLE_DOWN_RX, (_m, verb, obj) => `${verb}down${obj || ""}`);

/**
 * Something a person READS, judged as reading badly: "the password reset email text is confusing", "the text is way
 * too long on the pricing page". 8bf051980b narrowed the copy keywords to copy-sense phrases so "email" and "text" as a
 * CHANNEL stop convening the copy checks, and that left these plain complaints about words with no keyword at all
 * (the skeptic pass on it, 2026-09-26: copy-audit 0.97 -> 0.15 on the keyword arm, which is what the hook runs when Jev
 * times out). The pairing is the discriminator: a channel fact names no reading judgment, and "takes too long to load"
 * or "confusing to navigate" is speed or UX, not words.
 */
const READ_THING = String.raw`(?:copy|text|wording|words|e-?mails?|pages?|headlines?|buttons?|cta|labels?|messages?|subject line|paragraphs?|blurbs?|descriptions?|intro|tagline|bio)`;
const READ_JUDGMENT = String.raw`(?:confus\w*\b(?! to (?:navigate|use|find|set up))|unclear|(?:way |far |much )?too (?:long|wordy|dense|vague)\b(?! to\b)|wordy|verbose|boring|awkward|clunky|robotic|bland|cringe\w*|salesy|spammy|hard to (?:read|follow|understand)|reads (?:like|badly|weird|wrong)|makes no sense|doesn'?t make sense)`;
const COPY_JUDGED_RX = new RegExp(
  String.raw`\b${READ_THING}\b(?:(?!\b(?:takes?|took|taking|loads?|loading)\b)[^.?!\n]){0,40}?\b${READ_JUDGMENT}|\b${READ_JUDGMENT}(?:\s+\w+){0,2}\s+${READ_THING}\b`,
  "i",
);
export const copyJudged = (text) => COPY_JUDGED_RX.test(String(text || ""));

/** The same answer shape Jev gives, from keywords alone - what a docket runs on when Jev is unreachable. */
export function heuristicAnswers(bench, ask, { url = null } = {}) {
  const text = keywordText(ask);
  const answers = {};
  const mark = (id, answer, p, probabilities) => {
    answers[id] = { answer, confidence: p, probabilities: probabilities || {}, source: "heuristic" };
  };

  let askClass = "question";
  for (const [cls, rx] of Object.entries(CLASS_RX)) {
    if (rx.test(text)) {
      askClass = cls;
      break;
    }
  }
  mark("ask_class", askClass, 0.55);

  const domainScores = {};
  for (const [d, words] of Object.entries(bench.domains || {})) domainScores[d] = countHits(text, words);
  if (url) domainScores.copy = (domainScores.copy || 0) + 0.5;
  const wordsJudged = copyJudged(text);
  if (wordsJudged) domainScores.copy = (domainScores.copy || 0) + 1;
  const topDomain = Object.entries(domainScores).sort((a, b) => b[1] - a[1])[0];
  // No domain word at all: a grievance is a page matter only when it names a page. The old default filed every such
  // complaint, review or decision as copy, an opinion matter: "triage every open thread on the team board, fix what is
  // still broken" convened the product room and the copy checks on nothing (2026-09-29). "review the landing page"
  // still reads as a page. An ask that orders a page-only instrument is made a page matter by decideDocket's pageOrder.
  const namesPage = Boolean(url) || PAGE_WORDS_RX.test(text);
  const domain =
    topDomain && topDomain[1] > 0 ? topDomain[0] : askClass !== "build" && askClass !== "question" && namesPage ? "copy" : "code";
  mark("domain", domain, topDomain && topDomain[1] > 1 ? 0.7 : 0.4, domainScores);

  const scope = /\b(everything|all of it|do all|full|thorough|tribunal|entire|whole (?:page|site|flow))\b/i.test(text)
    ? 2
    : text.length < 60
      ? 0
      : 1;
  mark("scope", String(scope), 0.5);

  const sweep = /\b(find (?:all|every)|every|each|count|how many|enumerate|sweep|list all|across all)\b/i.test(text);
  const delegation = sweep ? "hswarm" : askClass === "complaint" || askClass === "review" ? "mixed" : "flagship";
  mark("delegation", delegation, 0.5);

  for (const inst of bench.instruments) {
    if (!inst.jev) continue;
    const hits = countHits(text, inst.keywords || []) + (wordsJudged && inst.id === "copy-audit" ? 1 : 0);
    let p = hits > 0 ? Math.min(0.95, 0.5 + 0.15 * hits) : 0.15;
    if ((inst.domains || []).includes(domain)) p = Math.min(0.97, p + 0.2);
    // The board is the venue for every grievance: a complaint with no opinion-word in it is still a judgment call.
    if (inst.id === "boardroom" && (askClass === "complaint" || askClass === "review" || askClass === "decision")) p = Math.max(p, 0.8);
    mark(`inst:${inst.id}`, p >= 0.5 ? "yes" : "no", Math.abs(p - 0.5) * 2, { yes: p, no: 1 - p });
  }
  return answers;
}

export function pYes(row) {
  if (!row) return 0;
  const p = row.probabilities && typeof row.probabilities.yes === "number" ? row.probabilities.yes : null;
  if (p !== null) return p;
  return row.answer === "yes" ? 0.8 : 0.2;
}

/** The roster's yes/no questions, one per capability (`member:<id>`, so a member answer can never collide with an
 *  instrument's), the same typed shape Jev is asked for an instrument. */
export function buildMemberQuestions(roster, ask) {
  return (roster.capabilities || [])
    .filter((row) => row.jev)
    .map((row) => ({ id: `member:${row.id}`, state: ask, type: "yesno", question: row.jev }));
}

/** The roster's questions answered from the ask's own words: `countHits` over the row's keywords, the same bar and
 *  answer shape the instruments' keyword arm uses (heuristicAnswers: 0.5 + 0.15 a hit, 0.95 cap), so a member's goal
 *  docket reads the same whichever roster answered it. */
export function memberHeuristicAnswers(roster, ask) {
  const text = keywordText(ask);
  const answers = {};
  for (const row of roster.capabilities || []) {
    const hits = countHits(text, row.keywords || []);
    const p = hits > 0 ? Math.min(0.95, 0.5 + 0.15 * hits) : 0.15;
    answers[`member:${row.id}`] = {
      answer: p >= 0.5 ? "yes" : "no",
      confidence: Math.abs(p - 0.5) * 2,
      probabilities: { yes: p, no: 1 - p },
      source: "heuristic",
    };
  }
  return answers;
}

/**
 * The member's goal checklist: EVERY row of the roster with the setting that governs it, ordered by how strongly the
 * ask is about it (roster order on a tie), each marked yes when Jev or the keywords said so. That is what `--member`
 * returns - a member's goal is a reading of their own settings, never a hearing.
 */
export function memberChecklist(roster, { answers = {} } = {}) {
  return (roster.capabilities || [])
    .map((row, at) => {
      const answer = answers[`member:${row.id}`] || null;
      return { row, at, answer, p: pYes(answer) };
    })
    .sort((a, b) => b.p - a.p || a.at - b.at)
    .map(({ row, answer, p }) => ({
      id: row.id,
      name: row.name,
      setting: row.setting,
      owner: row.owner,
      capability: row.capability,
      answer: answer ? (p >= 0.5 ? "yes" : "no") : null,
      p: Number(p.toFixed(3)),
      source: answer?.source || null,
    }));
}

/** The checklist for the member: the head says how many settings the ask is about, then one ticked line per setting in
 *  the checklist's order, each ending in the exact constant or dial it names. */
export function renderMemberChecklist(rows, { file = null, source = "heuristic", ask = "" } = {}) {
  const inPlay = rows.filter((r) => r.answer === "yes").length;
  const lines = [
    `MEMBER GOAL${ask ? ` · ${ask}` : ""} · ${inPlay} of ${rows.length} setting(s) in play · decided by ${source}`,
  ];
  for (const [i, r] of rows.entries())
    lines.push(`  ${`${i + 1}.`.padEnd(4)} ${r.answer === "yes" ? "[x]" : "[ ]"} ${r.id.padEnd(16)} p=${r.p}  ${r.setting}`);
  if (file) lines.push(`roster: ${file}`);
  return lines.join("\n");
}

/**
 * Jev's answers with the gaps filled from the heuristic. Jev answers item by item, so a key that dies mid-batch
 * leaves some ids with no answer; the docket used to take the partial set whole, and an unanswered ask_class or
 * domain silently became "question" / "copy" under "decided by jev" (2026-09-22). `filled` names every id the
 * heuristic answered, so the docket can say so.
 */
export function mergeAnswers(jev, heuristic) {
  const answers = { ...heuristic };
  const filled = [];
  for (const id of Object.keys(heuristic)) {
    const row = jev?.[id];
    if (row && row.answer !== null && row.answer !== undefined) answers[id] = row;
    else filled.push(id);
  }
  for (const [id, row] of Object.entries(jev || {})) if (!(id in heuristic) && row?.answer != null) answers[id] = row;
  return { answers, filled };
}

/**
 * Match a URL to design-critic surfaces: the plane from the host (<plane>.example.com, apex = main)
 * and the route from the path. Exact route first, then the same plane's landing surfaces.
 */
export function matchSurfaces(surfaces, url, limit = 6) {
  if (!url || !Array.isArray(surfaces)) return [];
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const host = u.hostname.toLowerCase();
  let plane = null;
  const m = /^([a-z0-9-]+)\.(?:get)?connections\.(?:icu|app|co)$/.exec(host);
  if (m) plane = m[1] === "www" ? "main" : m[1];
  else if (/^(?:get)?connections\.(?:icu|app|co)$/.test(host) || host === "localhost") plane = "main";
  const route = u.pathname.replace(/\/+$/, "") || "/";
  const rows = surfaces.filter((s) => s && typeof s.id === "string" && !s.id.startsWith("$"));
  const samePlane = rows.filter((s) => (s.plane || "main") === plane);
  // The same normalisation on both sides: a surface at "/" used to strip to "" and never match the page's "/", so
  // every landing page reached the roster only through the fallback below.
  const exact = samePlane.filter(
    (s) =>
      (String(s.route || "")
        .split("?")[0]
        .replace(/\/+$/, "") || "/") === route,
  );
  // A localhost page is on the roster only by its exact route: a dev server of the main SPA serves /demo, but a
  // local file server serving anything else is off-roster, and the landing fallback sent the wave to photograph
  // home-contacts and main-landing for the explainer on :4919 (2026-09-22). Off-roster goes the adhoc way.
  const picked = exact.length
    ? exact
    : host === "localhost"
      ? []
      : samePlane.filter((s) => String(s.route || "") === "/" || /landing|home/i.test(s.id));
  return picked.slice(0, limit).map((s) => s.id);
}

const PAGE_STOP = new Set(
  "the and for that this with page pages screen site from are was but not its our you your his her they them what why how when does look looks like feels very too all any can review fix ugly bad broken confusing cheap nobody people users visitors button buttons".split(
    " ",
  ),
);
const pageWords = (text) =>
  new Set(
    (
      String(text || "")
        .toLowerCase()
        .match(/[a-z][a-z0-9]{2,}/g) || []
    ).filter((w) => !PAGE_STOP.has(w)),
  );

/**
 * The roster pages an ask names in WORDS ("the pricing page looks cheap", "the boardroom sign-in is confusing"): the
 * design-critic surfaces whose id, title, plane or route share a word with the ask, most shared first, the ones with
 * a :param route after (a page of ONE record needs its id). A page matter that names no URL lists these, so the
 * caller passes --url instead of the room judging the ask's words.
 */
export function pagesNamed(surfaces, ask, limit = 5) {
  const words = pageWords(ask);
  if (!words.size || !Array.isArray(surfaces)) return [];
  return surfaces
    .filter((s) => s && typeof s.id === "string" && !s.id.startsWith("$"))
    .map((s) => {
      const own = pageWords(
        `${s.id.replaceAll("-", " ")} ${s.title || ""} ${s.plane || "main"} ${String(s.route || "").replace(/[/:]/g, " ")}`,
      );
      // A plane the ask names ("the boardroom sign-in") outranks a word shared with some other plane's page.
      return { s, hits: [...own].filter((w) => words.has(w)).length + (words.has(s.plane || "main") ? 1 : 0) };
    })
    .filter((r) => r.hits >= 1)
    .sort((a, b) => b.hits - a.hits || Number(String(a.s.route).includes(":")) - Number(String(b.s.route).includes(":")))
    .slice(0, limit)
    .map(({ s }) => ({ id: s.id, plane: s.plane || "main", route: s.route || "/", title: s.title || "" }));
}

/** bench + answers -> the docket: what to convene, in what order, and why. */
export const NOBODY_UNDERSTANDS_RX =
  /\b(?:nobody|no one|no-one|none of them|people (?:can'?t|cannot|don'?t|do not)|users (?:can'?t|cannot|don'?t|do not)|visitors (?:can'?t|cannot|don'?t|do not))\b/i;
/** A PERSON who could not do the thing ("grandma couldn't find the sign in button"): a real visitor failed at a task,
 *  which one instrument cannot answer - the quick look sent the flow walk alone where the gold wants LilGranny and SUE
 *  (eval, 2026-09-23). Floors the scope at a focused review; never the full tribunal. */
export const SOMEONE_FAILED_RX =
  /\b(?:couldn'?t|could not|can'?t|cannot|didn'?t|did not|never) (?:find|see|figure out|work out|get (?:in|past|through)|sign (?:in|up)|log ?in|finish|complete)\b/i;

/** The floors under the classifier's scope: a named page is at least a focused review; a complaint that people do not
 *  understand the product is a full tribunal. Measured 2026-09-22: the same complaint read as quick look, focused and
 *  tribunal on three runs; the floors make the size of a hearing a rule where a rule is obvious. `forced` wins outright. */
export function scopeFor({ classifierScope, ask, url, askClass, forced = null }) {
  if (forced != null && Number.isFinite(Number(forced))) return Math.max(0, Math.min(2, Number(forced)));
  let scope = Number.isFinite(Number(classifierScope)) ? Number(classifierScope) : 1;
  const grievance = askClass === "complaint" || askClass === "review" || CLASS_RX.complaint.test(String(ask || ""));
  if (url && grievance) scope = Math.max(scope, 1);
  // A decision ("should we cut the second pricing card?") is the room's by definition, and a quick look seats one
  // instrument - so the classifier's "quick" handed the one slot to subtract and the room never sat (eval, 2026-09-23).
  if (askClass === "decision") scope = Math.max(scope, 1);
  if (grievance && SOMEONE_FAILED_RX.test(String(ask || ""))) scope = Math.max(scope, 1);
  if (grievance && NOBODY_UNDERSTANDS_RX.test(String(ask || ""))) scope = 2;
  return Math.max(0, Math.min(2, scope));
}

/** Names people use for an instrument beyond its id and its bench name (the Chair's own words, 2026-09-22). */
const SPOKEN_NAMES = {
  lilgranny: ["little granny", "lil granny"],
  arkitect: ["architect"],
  "copy-audit": ["copy checks"],
  atlas: ["aws atlas"],
  "design-critic": ["design critic"],
};
const PAGE_WORDS_RX = /\b(?:page|pages|landing|home ?page|pricing|screen|site|website|visitors?|sign-?up|sign-?in|checkout)\b/i;
/** An ask about a desktop app's own UI - a native toolkit named, or the app called a desktop/native app. No browser opens
 *  it, so it is never a missing page and the page field stays home (FILTERS native-ui-no-visit). An Electron or Tauri
 *  app renders a web page and is not named here. VectorMagik's egui review, 2026-09-23. */
export const NATIVE_UI_RX =
  /\b(?:egui|eframe|iced|slint|gtk\d?|qt|qml|pyqt\d?|pyside\d?|wpf|winui|winforms|swiftui|appkit|javafx|tkinter|wxwidgets|imgui|(?:desktop|native) app(?:lication)?s?)\b/i;
const TOOL_WORK_RX =
  /\b(?:code|bugs?|review|audit|refactor|consolidat\w*|instruments?|tools?|fan(?:ning)? out|planes?|scripts?|tests?|runners?)\b/i;

/**
 * The bench instruments an ask names as its SUBJECT - "fan out over SUE, the design critic and the arkitect and check
 * their code", "consolidate the copy checks and LilGranny into the Architect" - rather than as tools to point at a page.
 * Two or more named, no page named (no URL, no page words) and a word about code or the tools themselves. Measured on
 * the gold asks (2026-09-22): Jev read both such asks as flow or copy matters and sent SUE and the Design Critic to look
 * at a page nobody named. Pure.
 */
export function toolsAsSubject(bench, ask, url) {
  const text = String(ask || "");
  if (url || PAGE_WORDS_RX.test(text) || !TOOL_WORK_RX.test(text)) return [];
  const lower = text.toLowerCase();
  const named = bench.instruments.filter((i) => namesOf(i).some((n) => new RegExp(`(?<![\\w-])${escRx(n)}(?![\\w-])`).test(lower)));
  return named.length >= 2 ? named.map((i) => i.id) : [];
}

const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What people call an instrument: its id, the id spaced out, its bench name's head, and its spoken names. Lower case. */
function namesOf(inst) {
  const short = String(inst.name || "")
    .split(" - ")[0]
    .replace(/^the /i, "");
  return [inst.id, inst.id.replace(/-/g, " "), short, ...(SPOKEN_NAMES[inst.id] || [])]
    .map((n) => n.toLowerCase().trim())
    .filter((n) => n.length >= 3);
}

// An order is an imperative at the start of the ask or a clause ("run", "please send", "and then start"), a
// determiner, at most one word more, then the instrument's name. "What do focus groups do" names one and orders none.
// The verb counts in any tense an owner dictates it in ("running Sue's through it", "keep sending Sues"), not only the
// bare imperative: Owner, 2026-09-27, "start burning down connections, running Sue's through it" ordered nothing.
const ORDER_LEAD = String.raw`(?:^|[.;,!?:]\s*|\b(?:please|pls|can you|could you|would you|let'?s|go|and|then|now|also|just|by|keep|start|begin|try)\s+)`;
const ORDER_VERB = String.raw`(?:run(?:s|ning)?|send(?:s|ing)?|start(?:s|ing)?|launch(?:es|ing)?|conven(?:e|es|ing)|hold(?:s|ing)?|do(?:es|ing)?|put(?:s|ting)?|kick(?:s|ing)? off|fir(?:e|es|ing) off|spin(?:s|ning)? up|set(?:s|ting)? up)`;
const ORDER_DET = String.raw`(?:(?:a|an|the|another|one more|the next|a new|some|our|my)\s+)?`;

/**
 * The bench instruments an ask ORDERS by name - "run a focus group on the pricing page", "please send the next focus
 * group at pass" - which convene whatever the classifier made of the rest. Owner, 2026-09-24: "run a focus group of
 * Sues on a page" read as a question, the page-visit veto kept the focus group home, and the docket said "answer it
 * directly". A name that is only another name's adjective ("a Sue focus group") is not a second order. Pure.
 */
export function instrumentsOrdered(bench, ask) {
  const text = String(ask || "").toLowerCase();
  const all = bench.instruments.flatMap((i) => namesOf(i).map((n) => ({ id: i.id, n })));
  const nameAt = (rest) => all.some(({ n }) => new RegExp(`^\\s*${escRx(n)}(?:s|es)?(?![\\w-])`).test(rest));
  const ordered = [];
  for (const { id, n } of all) {
    if (ordered.includes(id)) continue;
    const rx = new RegExp(`${ORDER_LEAD}${ORDER_VERB}\\s+${ORDER_DET}(?:[\\w'-]+\\s+)?${escRx(n)}(?:s|es)?(?![\\w-])`, "g");
    for (const m of text.matchAll(rx)) {
      if (!nameAt(text.slice(m.index + m[0].length))) {
        ordered.push(id);
        break;
      }
    }
  }
  return ordered;
}

/**
 * SIGNED VOTES, and the signals still on trial. The idea is PyTorch's target determination (their
 * tools/testing/target_determination/heuristics/interface.py, BSD-3-Clause); the code is written fresh for Dredd.
 * Every signal about an instrument is one vote in -1..1: negative keeps it home, 0 is no idea, the magnitude is how
 * sure. A signal's yes p is the vote 2p - 1. The live votes are summed in ONE place (tallyVotes) into the p every bar
 * and veto in decideDocket reads. A signal that is new enters on TRIAL: its vote is written into every docket
 * (`docket.votes`), and the docket says what it WOULD convene if that signal voted, so the eval can grade the trial
 * against the gold before it gets a vote. Graduating one is `votes: true` here: a decision change, A/B'd like any other.
 * WHY: until now the keywords were only ever a fallback for an id Jev left unanswered, and nothing could say whether
 * they would help beside Jev; a new signal (history, a peer's rating) had nowhere to be measured before it decided.
 */
export const TRIAL_SIGNALS = {
  keywords: { votes: false, why: "the keyword heuristic as a second voter beside Jev (live, it only answers an id Jev left unanswered)" },
};

/** The signals on trial for one ask: `{ signal: answers }`. The keywords only trial beside another voice: on a keyword
 *  docket they already are the live vote, and the same voice twice is one vote. Pure. */
export function trialSignals(bench, ask, { url = null, answers = {} } = {}) {
  const asked = Object.keys(answers || {}).filter((id) => id.startsWith("inst:"));
  if (!asked.some((id) => answers[id]?.source !== "heuristic")) return {};
  return { keywords: heuristicAnswers(bench, ask, { url }) };
}

/** The signals that vote by default: the trials that graduated. */
export const PROMOTED_SIGNALS = Object.entries(TRIAL_SIGNALS)
  .filter(([, s]) => s.votes)
  .map(([id]) => id);

/**
 * One row per bench instrument: the p decideDocket reads and every vote behind it. The live vote is the door's answer
 * (Jev, or the keywords where Jev was silent or unreachable). A trial signal's vote is recorded and counts only when
 * `promote` names it; then the votes are summed, held to -1..1 and read back as p. With no promoted vote the p is the
 * live answer's own, untouched, so a trial can never move a docket. A trial row that is silent is no vote. Pure.
 */
export function tallyVotes({ bench, answers, trials = {}, promote = PROMOTED_SIGNALS }) {
  const rows = new Map();
  for (const inst of bench.instruments) {
    const key = `inst:${inst.id}`;
    const live = answers?.[key];
    const own = pYes(live);
    const votes = live ? [{ signal: live.source === "heuristic" ? "keywords" : "jev", vote: round2(2 * own - 1), trial: false }] : [];
    // No live answer is no live vote: 0, not the -1 that pYes(null) = 0 would read as once a signal is promoted.
    let sum = live ? 2 * own - 1 : 0;
    let promoted = false;
    for (const [signal, given] of Object.entries(trials || {})) {
      const row = given?.[key];
      if (!row || row.answer === null || row.answer === undefined) continue;
      if (row.source && row.source === live?.source) continue;
      const vote = 2 * pYes(row) - 1;
      const counts = promote.includes(signal);
      votes.push({ signal, vote: round2(vote), trial: !counts });
      if (counts) {
        sum += vote;
        promoted = true;
      }
    }
    rows.set(inst.id, { p: promoted ? (1 + Math.max(-1, Math.min(1, sum))) / 2 : own, votes });
  }
  return rows;
}

/**
 * `paths` are the repository paths the ask names that EXIST (dredd.mjs checks the disk before deciding: a code gate
 * on a typo is a false red, and prose like "sign-in/sign-up" or "UI/UX" used to convene the Architect repo-wide before
 * the filter ran - 2026-09-22). Left out, the pure extractPaths(ask) stands in, which is what the tests drive.
 */
export function decideDocket({
  bench,
  ask,
  url = null,
  answers,
  source = "jev",
  surfaces = [],
  forcedScope = null,
  paths = null,
  bars = BARS,
  trials = null,
  promote = PROMOTED_SIGNALS,
  shadow = true,
}) {
  const get = (id) => answers[id] || null;
  // Every instrument's p is the sum of its live votes (tallyVotes); a trial signal is recorded beside it, never counted.
  const trialRows = trials ?? trialSignals(bench, ask, { url, answers });
  const tallied = tallyVotes({ bench, answers, trials: trialRows, promote });
  const pOf = (id) => tallied.get(id)?.p ?? pYes(get(`inst:${id}`));
  const askClass = get("ask_class")?.answer || "question";
  // An ask whose subject is our own instruments is about their code, whatever the classifier read in their names. So is an
  // ask that names code in the repository and no page: the eval read "tear dredd apart" as a product matter and
  // sat LilGranny and SUE on it (2026-09-23).
  const subjects = toolsAsSubject(bench, ask, url);
  const named = paths ?? extractPaths(ask);
  // An instrument the ask orders by name convenes; one it names as a subject is judged as code instead.
  const ordered = instrumentsOrdered(bench, ask).filter((id) => !subjects.includes(id));
  const codeMatter = subjects.length || (!url && named.some(isCodePath));
  // Ordering an instrument that only ever judges a page ("run a focus group") makes it a page matter: read as a
  // question, the heuristic's default domain was "code", and the matter line sent it to the Architect.
  const pageOrder = bench.instruments.find(
    (i) => ordered.includes(i.id) && (i.domains || []).length && i.domains.every((d) => PAGE_OR_PRODUCT_DOMAINS.has(d)),
  );
  const classified = get("domain")?.answer || "copy";
  const domain = codeMatter
    ? "code"
    : pageOrder && !pageOrder.domains.includes(classified) && !PAGE_OR_PRODUCT_DOMAINS.has(classified)
      ? pageOrder.domains[0]
      : classified;
  const scope = scopeFor({ classifierScope: get("scope")?.answer, ask, url, askClass, forced: forcedScope });
  const rawDelegation = get("delegation")?.answer;
  // An unknown or malformed tier clamps to mixed: never an invented flagship or desktop worker.
  const delegation = typeof rawDelegation === "string" && Object.hasOwn(DELEGATION, rawDelegation) ? rawDelegation : "mixed";
  // A complaint word in the text makes it a hearing even when the classifier read "fix all of it" as a build.
  const grievance =
    askClass === "complaint" || askClass === "review" || askClass === "decision" || CLASS_RX.complaint.test(String(ask || ""));

  const scored = bench.instruments
    .filter((i) => i.jev)
    .map((i) => ({ inst: i, p: pOf(i.id), conf: get(`inst:${i.id}`)?.confidence ?? 0 }))
    // Run order is by phase (the facts before the room that argues over them). A quick look convenes ONE instrument,
    // so there the likeliest goes first: by phase, "the button is ugly" handed its one slot to the room and never
    // called the Design Critic (the eval's convened tally, 2026-09-22).
    .sort((a, b) => (scope === 0 ? b.p - a.p : a.inst.phase - b.inst.phase || b.p - a.p));

  const convene = [];
  const also = [];
  const capFocused = 4;
  // The filter stage (lib/pipeline.mjs FILTERS): the rules that keep an instrument home whatever its p, each named, so
  // the docket's `home` says which rule kept which instrument home instead of a bare absence.
  const filterCtx = {
    grievance,
    subjects,
    askClass,
    url,
    // Not the `codeMatter` above (subjects or a code path): this is the matter's routed kind.
    codeKind: matterFor(domain).kind === "code",
    roomAsked: ROOM_ASKED_RX.test(String(ask || "")),
    nativeUi: NATIVE_UI_RX.test(String(ask || "")),
  };
  const vetoedBy = (inst, p) => filtersKeepingHome(inst, p, filterCtx);
  const vetoed = (inst, p) => vetoedBy(inst, p).length > 0;
  // Why each instrument not seated stayed home: { stage: filter | bar | cap | bill, filters?, why? }, by id.
  const homeWhy = new Map();
  for (const row of scored) {
    const { inst, p } = row;
    // The score stage: the scope's bar. A quick look seats ONE instrument, but a session skill (phase 4: the Humanizer,
    // the marketing council) costs nothing to name, so it may sit beside that one: "this welcome email reads like a
    // robot" gave its slot to the copy checks and never named the Humanizer at p 0.87 (eval, 2026-09-23). A field
    // instrument clears the higher bar.
    const scoredStage = scoreStage(inst, p, scope, bars, convene);
    let take = scoredStage.take;
    const filters = vetoedBy(inst, p);
    if (filters.length) take = false;
    homeWhy.set(inst.id, filters.length ? { stage: "filter", filters } : { stage: "bar", why: scoredStage.why });
    // An order is the operator's own call, not a reading of the ask: no bar and no veto keeps it home.
    if (ordered.includes(inst.id)) take = true;
    if (take) convene.push({ id: inst.id, name: inst.name, phase: inst.phase, mode: inst.mode, p: round2(p), why: inst.when });
    else if (p >= 0.4) also.push({ id: inst.id, name: inst.name, p: round2(p) });
  }
  // The focused cap keeps the ask's own SPECIALISTS (the instruments whose domains hold the ask's domain), then the higher
  // p. Taken in run order, the cheap facts filled it first: "signup keeps dead-ending, people just give up" seated the
  // pulse at 0.56 and the code graph and cut SUE at 0.71 on a flow complaint (eval, 2026-09-23).
  // The board is never a cap seat (2026-10-09): it argues over the facts the other seats gather, and it spans every domain,
  // so it fitted each ask and lost every tie on p. A new field seat (ART, p 0.73) pushed the board's p 0.61 out of the four
  // on review-landing, and the room the eval wants in that docket went home (replayed: the same answers convene the board
  // without ART). The cap counts the field seats only; the board sits beside them.
  const isRoom = (c) => c.id === "boardroom";
  const fieldSeats = convene.filter((c) => !isRoom(c));
  if (scope === 1 && fieldSeats.length > capFocused) {
    const fit = (c) => ((bench.instruments.find((i) => i.id === c.id)?.domains || []).includes(domain) ? 1 : 0);
    const asked = (c) => (ordered.includes(c.id) ? 1 : 0);
    const keep = new Set(
      [...fieldSeats]
        .sort((a, b) => asked(b) - asked(a) || fit(b) - fit(a) || b.p - a.p)
        .slice(0, capFocused)
        .map((c) => c.id),
    );
    for (const c of fieldSeats.filter((x) => !keep.has(x.id))) {
      also.push({ id: c.id, name: c.name, p: c.p });
      homeWhy.set(c.id, {
        stage: "cap",
        why: `a focused review seats ${capFocused}: the ask's specialists and the higher p took the seats`,
      });
    }
    convene.splice(0, convene.length, ...convene.filter((c) => isRoom(c) || keep.has(c.id)));
  }
  // A docket that seats NOTHING answers nobody: "ugly button" cleared no bar (the Design Critic at 0.63) and went home
  // empty, and so did "what did the design critic last say" (the board at 0.55). The likeliest instrument sits when Jev
  // leans yes at all (p >= 0.5) and no veto keeps it home - never the room alone, which argues over facts it would not
  // have. The SPECIALIST for the ask's domain goes first (it judges that domain, and the fewest others), then the higher
  // p: by p alone "ugly button" seated the room, then SUE, before the Design Critic (eval, 2026-09-23).
  if (convene.length === 0) {
    const fit = (inst) => ((inst.domains || []).includes(domain) ? 1 : 0);
    const breadth = (inst) => (inst.domains || []).length || 99;
    const best = [...scored]
      .sort((a, b) => fit(b.inst) - fit(a.inst) || breadth(a.inst) - breadth(b.inst) || b.p - a.p)
      .find((row) => row.p >= 0.5 && row.inst.id !== "boardroom" && !vetoed(row.inst, row.p));
    if (best) {
      const { inst, p } = best;
      convene.push({ id: inst.id, name: inst.name, phase: inst.phase, mode: inst.mode, p: round2(p), why: inst.when });
      const i = also.findIndex((a) => a.id === inst.id);
      if (i >= 0) also.splice(i, 1);
    }
  }
  // The board is only worth convening once it has facts to argue over; a docket with the board alone
  // still runs it, but the order below puts every phase-1 instrument first.
  // Rung one of the page ladder: a named page gets its pulse taken before anything else about it is judged
  // (the Chair, 2026-09-22: "first, is the page fucked?"). A quick look stays one instrument.
  const pulse = bench.instruments.find((i) => i.id === "page-pulse");
  if (url && pulse && scope >= 1 && !convene.some((c) => c.id === "page-pulse")) {
    convene.push({ id: pulse.id, name: pulse.name, phase: pulse.phase, mode: pulse.mode, p: 0.9, why: "a page is named: rung one" });
    const i = also.findIndex((a) => a.id === "page-pulse");
    if (i >= 0) also.splice(i, 1);
  }
  // Rung two ("does the design look good?") is a fixed rung of any page hearing the same way rung one is: the
  // critic photographs whatever page is named, whatever Jev's yes said about the complaint's words (the first
  // unattended hearing left rung two dark because a copy-shaped complaint sat the critic under the bar - 2026-09-22).
  // Rungs two and four are PAGE rungs: a named host on an infra matter ("does example.com resolve, the cert
  // looks off") is asked about its certificate, not its looks or its visitors - forcing both there broke two must-nots
  // at p 0.09 and 0.10 (eval, 2026-09-23). Rung one still takes the page's pulse.
  const pageMatter = domain === "visual" || domain === "copy" || domain === "flow" || domain === "product";
  const critic = bench.instruments.find((i) => i.id === "design-critic");
  if (url && critic && grievance && pageMatter && scope >= 1 && !convene.some((c) => c.id === "design-critic")) {
    convene.push({ id: critic.id, name: critic.name, phase: critic.phase, mode: critic.mode, p: 0.9, why: "a page is named: rung two" });
    const i = also.findIndex((a) => a.id === "design-critic");
    if (i >= 0) also.splice(i, 1);
  }
  // Rung four ("can people understand it?") is fixed the same way: a page hearing sends visitors whatever Jev's yes
  // said, because without them the ladder cannot answer the rung, Grandma Sue has nothing to report, and the ballot's
  // cap never bites (the explainer hearing of 2026-09-22 ran with no visitors because the ask read as a review).
  // `--skip sue` is the opt-out; SUE's own refusal (no brain, no mailroom) is the other way it does not run.
  // An ask about attention or drop-off on a named page needs the visitors whether it is worded as a complaint or a
  // question: the retention critics (convene.mjs `criticsFor`) ride only beside SUE, and "where do we lose their
  // attention" read as a question left SUE at 0.71 in `also` and both critics home (2026-09-28).
  const sue = bench.instruments.find((i) => i.id === "sue");
  const visitorsAsked = grievance || RETENTION_ASK.test(String(ask || ""));
  if (url && sue && visitorsAsked && pageMatter && scope >= 1 && !convene.some((c) => c.id === "sue")) {
    convene.push({ id: sue.id, name: sue.name, phase: sue.phase, mode: sue.mode, p: 0.9, why: "a page is named: rung four" });
    const i = also.findIndex((a) => a.id === "sue");
    if (i >= 0) also.splice(i, 1);
  }
  // A code matter that names a path is the Architect's, by the same message that made it so ("the architect is the
  // architect"): its code-quality family runs whatever Jev's yes said, the way rung one runs on any page. Dredd's
  // second hearing on itself (2026-09-22) had Jev leave the Architect off a code review and the room argued from a
  // grid line instead of findings.
  if (grievance && matterFor(domain).kind === "code" && named.length) {
    for (const id of ["code-gate", "arkitect"]) {
      const inst = bench.instruments.find((i) => i.id === id);
      if (!inst || convene.some((c) => c.id === id)) continue;
      const checks = (inst.checksByDomain || {})[domain];
      if (id === "arkitect" && (!checks || checks[0] === "*strict*")) continue;
      convene.push({
        id,
        name: inst.name,
        phase: inst.phase,
        mode: inst.mode,
        p: 0.9,
        why:
          id === "arkitect"
            ? "a code matter names a path: the Architect's code family"
            : "a code matter names a path: the code gate runs on it",
      });
      const i = also.findIndex((a) => a.id === id);
      if (i >= 0) also.splice(i, 1);
    }
  }
  // A money matter is the bill's, and the bill goes first whatever Jev's yes said (Owner, 2026-09-23: "all I should tell
  // you to do is go check the account spend, and you should naturally be routed through Dredd"). Before it, that very ask
  // convened the Architect's atlas checks and nothing that reads a dollar. A quick look's one slot is the bill's.
  const bill = domain === "money" ? bench.instruments.find((i) => i.id === "bill") : null;
  if (bill) {
    const had = convene.find((c) => c.id === bill.id);
    const p = had ? had.p : round2(Math.max(pOf(bill.id), 0.9));
    const others = convene.filter((c) => c.id !== bill.id);
    const bumped = scope === 0 ? others.filter((c) => c.phase !== 4) : [];
    const row = {
      id: bill.id,
      name: bill.name,
      phase: bill.phase,
      mode: bill.mode,
      p,
      why: "a money matter: the bill reads the dollars first",
    };
    convene.splice(0, convene.length, ...others.filter((c) => !bumped.includes(c)), row);
    also.push(...bumped.map(({ id, name, p: bp }) => ({ id, name, p: bp })));
    for (const c of bumped) homeWhy.set(c.id, { stage: "bill", why: "a money matter's quick look gives its one slot to the bill" });
    const i = also.findIndex((a) => a.id === bill.id);
    if (i >= 0) also.splice(i, 1);
  }
  const first = (c) => (bill && c.id === bill.id ? -2 : c.id === "page-pulse" ? -1 : 0);
  convene.sort((a, b) => a.phase - b.phase || first(a) - first(b) || b.p - a.p);

  // A which-tool question is answered by the bench: every instrument for the domain, whatever the yes/no said.
  const whichTool = WHICH_TOOL_RX.test(String(ask || ""));
  const haveFor = whichTool
    ? bench.instruments
        .filter((i) => i.mode !== "always" && ((i.domains || []).includes(domain) || pOf(i.id) >= 0.4))
        .map((i) => ({ id: i.id, name: i.name, judges: String(i.judges || "").split(". ")[0], run: i.run }))
    : [];
  const surfaceIds = matchSurfaces(surfaces, url);
  // Every scored instrument the docket left home, with the stage that kept it there and which scorer gave its p (Jev,
  // or the keywords where Jev left the item unanswered).
  const home = scored
    .filter(({ inst }) => !convene.some((c) => c.id === inst.id))
    .map(({ inst, p }) => ({
      id: inst.id,
      p: round2(p),
      // One clean scorer, never the docket-wide `source` ("jev+cascade+heuristic" would name the keywords for a row
      // Jev scored): the item's own source says heuristic, else Jev when Jev ran, else the keywords.
      scoredBy: get(`inst:${inst.id}`)?.source === "heuristic" || !String(source).startsWith("jev") ? "heuristic" : "jev",
      ...homeWhy.get(inst.id),
    }));
  const planes = [...new Set(surfaces.filter((s) => surfaceIds.includes(s.id)).map((s) => s.plane || "main"))];
  // A complaint about a page that names no page: every page rung needs one, so a convene would seat the room over the
  // ask's words and the Design Critic not at all (a peer's hearing, 2026-09-23: "its panel judged my written request
  // rather than the page, and its visual critic couldn't take part without a rendered page"). dredd.mjs refuses to
  // convene on it until --url names the page, or --no-page says there is none yet. A decision may be about a page
  // that does not exist yet (the veto above), and copy may be an email, so those need page words to count.
  const complaintOrReview =
    askClass === "complaint" || askClass === "review" || (askClass !== "decision" && CLASS_RX.complaint.test(String(ask || "")));
  const pageMissing =
    !url &&
    !subjects.length &&
    !filterCtx.nativeUi &&
    complaintOrReview &&
    (domain === "visual" || domain === "flow" || (pageMatter && PAGE_WORDS_RX.test(String(ask || ""))));
  // What each trial signal WOULD convene if it voted: the same decision with it promoted, one level deep. This is the
  // shadow the eval grades against the gold; the live convene above never reads it.
  const liveIds = convene.map((c) => c.id);
  const trial = {};
  for (const signal of shadow ? Object.keys(trialRows).filter((s) => !promote.includes(s)) : []) {
    const would = decideDocket({
      bench,
      ask,
      url,
      answers,
      source,
      surfaces,
      forcedScope,
      paths,
      bars,
      trials: trialRows,
      promote: [...promote, signal],
      shadow: false,
    }).convene.map((c) => c.id);
    trial[signal] = {
      why: TRIAL_SIGNALS[signal]?.why || "",
      convene: would,
      added: would.filter((id) => !liveIds.includes(id)),
      dropped: liveIds.filter((id) => !would.includes(id)),
    };
  }
  // A bug complaint carries its repro and the ladder its fix is ruled on (lib/bug.mjs): it changes nothing convened,
  // it changes what "fixed" may claim.
  const bug = bugFor({ ask, askClass });
  return {
    version: 1,
    ask,
    url,
    ...(pageMissing ? { page: { missing: true, named: pagesNamed(surfaces, ask) } } : {}),
    ...(filterCtx.nativeUi && !url ? { nativeUi: true } : {}),
    ...(bug ? { bug } : {}),
    class: askClass,
    domain,
    scope,
    scopeLabel: SCOPES[scope] ? SCOPES[scope].split(" - ")[0] : "focused review",
    delegation: {
      tier: delegation,
      ...DELEGATION_POLICY,
      profile: domain === "code" ? "code" : askClass === "decision" ? "decision" : "general",
      why: DELEGATION[delegation],
    },
    models: modelsFor(convene, bench),
    matter: subjects.length
      ? { ...matterFor(domain), why: `the ask is about our own instruments (${subjects.join(", ")}): their code, not a page` }
      : matterFor(domain),
    subjects,
    convene,
    also,
    home,
    surfaces: surfaceIds,
    planes,
    terms: keyTerms(ask),
    paths: named,
    whichTool,
    haveFor,
    firstSteps: firstStepsFor(bench, domain, ask),
    decidedBy: source,
    // Every asked instrument's votes, and what each trial signal would have convened (logged per docket in docket.json).
    votes: {
      promoted: promote,
      instruments: bench.instruments
        .filter((i) => i.jev)
        .map((i) => ({ id: i.id, p: round2(pOf(i.id)), votes: tallied.get(i.id)?.votes || [] })),
      trial,
    },
    confidence: {
      ask_class: round2(get("ask_class")?.confidence ?? 0),
      domain: round2(get("domain")?.confidence ?? 0),
      scope: round2(get("scope")?.confidence ?? 0),
    },
  };
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * The bench's fixed FIRST STEP lines for this docket: a step whose `domain` is the docket's and whose `when` words the
 * ask names, through the same matcher as the domain keywords. Ruling 2026-09-24 (the panel the owner delegated to,
 * decide-39): a delivery bug ("it came through email rather than text") starts at the operator's own send ledgers, and
 * the docket now says so even when it convenes nothing - no new instrument, which stays the Chair's call.
 */
export function firstStepsFor(bench, domain, ask) {
  const text = String(ask || "");
  return (bench.firstSteps || [])
    .filter((s) => s.domain === domain && countHits(text, s.when || []) > 0)
    .map(({ id, note }) => ({ id, note }));
}

/** How many Sues a hearing sends when a PAID brain thinks for them (OpenRouter, after the subscription rung refused):
 *  DREDD_SUE_COUNT_PAID, else three - five Sues on OpenRouter's DeepSeek cost $2.72 on the explainer (2026-09-22),
 *  and three is enough for rung four's rule (stars and the no-idea share). Never more than sueCount(). */
export function paidSueCount() {
  const n = Math.trunc(Number(process.env.DREDD_SUE_COUNT_PAID || 3));
  return Math.min(sueCount(), Math.max(1, Number.isFinite(n) ? n : 3));
}

/** How many Sues a hearing sends: DREDD_SUE_COUNT, else five. Shared by the render and the run. */
export function sueCount() {
  const n = Math.trunc(Number(process.env.DREDD_SUE_COUNT || 5));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 5;
}

/** Where a run line's `{dredd}` points: the engine's own folder, repo-relative inside Connections and absolute anywhere else. */
export function dreddDirFor(root, { engineDir = ENGINE_DIR } = {}) {
  const engineRoot = path.resolve(engineDir, "..");
  return !root || samePath(root, engineRoot) ? "dredd" : engineDir.replace(/\\/g, "/");
}

/**
 * One value as ONE argument on a shell line. A plain token (letters, digits and . , : / @ + = _ -, plus the backslash
 * on Windows) goes bare, so an ordinary run line - and a fairjob `-Run "..."` wrapper around it - reads exactly as
 * before. Anything else is quoted for the shell that will run it (2026-09-22: a --url with `&` in its query split the
 * page-pulse line in two, lost --out, and let the text after the `&` run as a command):
 *   sh:  single quotes, an embedded ' closed, escaped and reopened.
 *   cmd: double quotes, and every % stepped outside them as ^% - cmd expands %NAME% even inside double quotes, and
 *        splitting each % out leaves no name it could expand. A double quote or a line break cannot be carried
 *        through cmd safely at all, so it is refused rather than passed on half-quoted.
 */
export function shellArg(value, { shell = process.platform === "win32" ? "cmd" : "sh" } = {}) {
  const text = String(value);
  const plain = shell === "cmd" ? /^[\w.,:/@+=\\-]+$/ : /^[\w.,:/@+=-]+$/;
  if (plain.test(text)) return text;
  if (shell === "sh") return `'${text.replaceAll("'", "'\\''")}'`;
  if (/["\r\n]/.test(text)) throw new Error(`cannot pass ${JSON.stringify(text)} through cmd as one argument (a quote or a line break)`);
  // Every piece ends right before a closing quote, where the C runtime reads 2n backslashes as n, so a trailing run is
  // doubled or `C:\dir\` would escape its own closing quote.
  const pieces = text.split("%").map((s) => s.replace(/(\\+)$/, "$1$1"));
  return `"${pieces.join('"^%"')}"`;
}

/** Connections' services and runners live in the selected target, independently of Dredd's code. */
export function connectionsDirFor(dredd) {
  return targetRoot().replace(/\\/g, "/");
}

/**
 * The ask as an instrument's argument. An ask is prose and often quotes a headline or a person, and cmd cannot carry a
 * straight double quote or a line break inside one argument (shellArg refuses both), so every convene of an ask that
 * quoted anything died before a seat sat (a peer's Postal Buddy hearing, 2026-10-01; a SUE round's ask quotes its
 * students). Straight double quotes become curly ones and line breaks spaces: the words reach the instrument whole.
 */
export function askArg(ask) {
  return String(ask)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/"([^"]*)"/g, "\u201c$1\u201d")
    .replaceAll('"', "\u201d");
}

/** Fill a bench `run` template for this docket. Every real value is one shell argument (shellArg); the <...>
 *  placeholders stand in only on a printed docket, where nothing runs them. */
export function fillRun(
  template,
  { docketDir, url, ask, checks, surfaces, planes, term, paths, adhocFile, adhocName, sueArgsFile, dredd, connections = connectionsDirFor(), repo = connections, shell } = {},
) {
  const q = (v) => shellArg(v, shell ? { shell } : {});
  return (
    String(template || "")
      .replace(/\{(dredd|sue|connections|pagePulseRunner|arkitectCli|codeGateRunner|pricecheckCli)\}([/\\][^\s"']*)?/g, (_, key, suffix = "") => {
        const bases = {
          dredd: dredd || "dredd",
          sue: path.join(dredd || "dredd", "..", "sue").replace(/\\/g, "/"),
          connections,
          pagePulseRunner: targetPath(loadTarget().pagePulseRunner),
          arkitectCli: targetPath(loadTarget().arkitectCli),
          codeGateRunner: targetPath(loadTarget().codeGateRunner),
          pricecheckCli: pricecheckCli(),
        };
        return q(bases[key] + suffix);
      })
      .replaceAll("{repo}", q(repo))
      .replaceAll("{docket}", docketDir ? q(docketDir) : "<docket>")
      .replaceAll("{url}", url ? q(url) : "<url>")
      .replaceAll("{ask}", ask ? q(askArg(ask)) : "")
      .replaceAll("{checks}", checks && checks.length ? q(checks.join(",")) : "<checks>")
      .replaceAll("{surfaces}", surfaces && surfaces.length ? q(surfaces.join(",")) : "<surface-ids>")
      .replaceAll("{planes}", planes && planes.length ? q(planes.join(",")) : "<planes>")
      .replaceAll("{term}", term ? q(term) : "<term>")
      .replaceAll("{paths}", paths && paths.length ? paths.map(q).join(" ") : "<paths the ask names>")
      .replaceAll("{adhocFile}", adhocFile ? q(adhocFile) : "<docket>/adhoc.txt")
      // The adhoc capture's own folder name, one per docket (tmp/design-critic/adhoc/<name>/), so a second docket's wave
      // never lands where the first one's collect reads (lib/collect.mjs criticPaths).
      .replaceAll("{adhocName}", adhocName ? q(adhocName) : "dredd")
      .replaceAll("{sueArgsFile}", sueArgsFile ? q(sueArgsFile) : "<docket>/sue-args.json")
  );
}

/** The docket as the agent reads it. `compact` is the hook's shape (a dozen lines); the CLI prints the rest. */
/** What the docket says, and what a convene refuses with, when a page matter names no page. */
/** What the docket says when the ask is about a desktop app's own UI (NATIVE_UI_RX, no page named): no page instrument
 *  can see it, so the session renders the screens and lists the strings, and the copy checks read the list
 *  (strings-copy.mjs). VectorMagik, 2026-09-23: that is what worked there, by hand. */
export function nativeUiLines({ docketDir = null, dredd = null } = {}) {
  const at = docketDir ? String(docketDir).replace(/\\/g, "/") : "<docket>";
  return [
    `DESKTOP UI: no browser opens this app, so no page instrument can see it. Render each screen headless into`,
    `  ${at}/screens/, list every UI string one per line in ${at}/ui-strings.txt (<where><TAB><string> cites its source),`,
    `  then run the copy checks over them: node ${dredd || "dredd"}/strings-copy.mjs --strings ${at}/ui-strings.txt --out ${at}/strings-copy.log`,
  ];
}

export function noPageLines(docket) {
  const named = docket.page?.named || [];
  return [
    `NO PAGE NAMED: this is a ${docket.domain} matter about a page, and nothing renders a page Dredd was not given - the`,
    `  critic cannot photograph it and the room would judge these words instead. Name it: --url <the page> (live https, or`,
    `  the plane's dev server, e.g. http://localhost:4173/<route>), or --no-page when the page does not exist yet.`,
    ...(named.length
      ? [`  The roster pages your words point at:`, ...named.map((p) => `    ${p.plane} ${p.route}  ${p.title || p.id}`)]
      : []),
  ];
}

/** Where an agent-phase instrument's result lands so the board reads it: `<docket>/<id>.log`. roomMaterial reads every
 *  .log in the docket, so a deep or security audit written there is evidence at the next sitting, and on a code matter
 *  it leads the page's words (SageThumbs 2K, 2026-09-23: the audit was answered "in the reply" and no line said where
 *  the room would see it). */
export function agentLandsAt(docketDir, id) {
  return `${String(docketDir).replace(/\\/g, "/")}/${id}.log`;
}

/**
 * The hook's docket when it convenes nothing: the verdict on ONE line, then only the lines that say something about this
 * ask - a page it needs named, a bug's rule, a first step, the tools a which-tool question asked for, the instruments
 * that just missed the bar, the memories that matched. The matter, the delegation policy and the hearing command stay in
 * docket.md. The hook was rated 2.3/5 by three chats (2026-09-22 to 09-24, "fired once and was not acted on"), and every
 * such docket spent ~1.2-2.8 KB of a chat's context repeating the ZSwarm policy the rules already carry.
 */
function renderNothingConvened(docket, { docketDir = null, dredd = null } = {}) {
  const lines = [
    `DREDD ${docket.class.toUpperCase()} · ${docket.domain} · decided by ${docket.decidedBy}${docket.url ? ` · ${docket.url}` : ""} - CONVENE: nothing; answer it directly (delegation: ${docket.delegation?.tier || "flagship"})`,
  ];
  if (docket.page?.missing) lines.push(...noPageLines(docket));
  if (docket.nativeUi) lines.push(...nativeUiLines({ docketDir, dredd }));
  lines.push(...bugLines(docket, { docketDir }));
  if (docket.root) lines.push(`ROOT: ${docket.root}`);
  for (const step of docket.firstSteps || []) lines.push(`FIRST STEP: ${step.note}`);
  lines.push(...haveForLines(docket, 6));
  if (docket.also?.length) lines.push(`YOU ALSO HAVE: ${docket.also.map((a) => `${a.id} (${a.p})`).join(" · ")}`);
  lines.push(...memoryLines(docket, 5));
  if (docket.mcpError) lines.push(`MCP: ${docket.mcpError}`);
  return lines.join("\n");
}

/** A which-tool question's answer: what the bench has for the ask's domain, one line each. */
function haveForLines(docket, limit) {
  if (!docket.whichTool || !docket.haveFor?.length) return [];
  return [
    `YOU HAVE, for ${docket.domain}:`,
    ...docket.haveFor
      .slice(0, limit)
      .map((h) => `  ${h.id.padEnd(17)} ${h.judges.length > 120 ? `${h.judges.slice(0, 117)}...` : h.judges}  → ${h.run}`),
  ];
}

/** The recalled memories, strongest first, one line each. The prompt hook's `<dredd-memories>` block prints the same
 *  lines (lib/hook-recall.mjs), so a memory reads alike wherever it was recalled. */
export function memoryLines(docket, limit) {
  if (!docket.memories?.length) return [];
  return [
    `MEMORIES (${docket.memorySource}, strongest first):`,
    ...docket.memories
      .slice(0, limit)
      .map((m) =>
        `  ${m.score != null ? `${m.score}%`.padStart(4) : "    "} [${m.slug}]${m.repo ? ` (${m.repo})` : ""} ${m.title || ""}`.trimEnd(),
      ),
  ];
}

export function renderDocket(docket, bench, { compact = false, docketDir = null, dredd = null, exists = existsSync } = {}) {
  if (compact && !docket.convene.length && !docket.hearing && !docket.results?.length)
    return renderNothingConvened(docket, { docketDir, dredd });
  const byId = new Map(bench.instruments.map((i) => [i.id, i]));
  const lines = [];
  const head = `DREDD ${docket.class.toUpperCase()} · ${docket.domain} · ${docket.scopeLabel} · decided by ${docket.decidedBy}${docket.url ? ` · ${docket.url}` : ""}`;
  lines.push(head);
  if (docket.page?.missing) lines.push(...noPageLines(docket));
  if (docket.nativeUi) lines.push(...nativeUiLines({ docketDir, dredd }));
  if (docket.heuristicFilled?.length)
    lines.push(`JEV LEFT ${docket.heuristicFilled.length} UNANSWERED, the keywords answered: ${docket.heuristicFilled.join(", ")}`);
  if (docket.matter) lines.push(`MATTER: ${docket.matter.kind} - ${docket.matter.why}`);
  lines.push(...bugLines(docket, { docketDir }));
  if (docket.root)
    lines.push(
      `ROOT: ${docket.root}${bench.filtered?.length ? ` - ${bench.filtered.length} Connections-only instrument(s) off this bench` : ""}`,
    );
  if (docket.convene.length) {
    lines.push(`CONVENE, in this order (phase 1 facts → 2 the board → 3 the field → 4 you):`);
    for (const c of docket.convene) {
      const inst = byId.get(c.id);
      const run = fillRun(inst?.run, {
        docketDir,
        url: docket.url,
        ask: docket.ask,
        checks: inst?.checks || (inst?.checksByDomain || {})[docket.domain],
        surfaces: docket.surfaces,
        term: (docket.terms || [])[0],
        paths: docket.paths,
        dredd,
        repo: docket.root,
        adhocFile: docketDir ? `${docketDir}/adhoc.txt` : null,
        sueArgsFile: docketDir ? `${docketDir}/sue-args.json` : null,
      });
      lines.push(`  ${c.phase}. ${c.id.padEnd(17)} p=${c.p}  ${inst?.mode === "agent" ? "YOU: " : ""}${run}`);
      const gone = inst ? missingMachineRunner(inst.run, { exists }) : null;
      if (gone) lines.push(`     NOT ON THIS MACHINE: ${gone} is missing (the doctor lists it) - skip it and say so in one line`);
      if (!compact && inst?.then) lines.push(`     then: ${inst.then}`);
      if (!compact && inst?.needs) lines.push(`     needs: ${inst.needs}`);
      if (!compact && inst?.mode === "agent" && docketDir)
        lines.push(
          `     lands: write its result to ${agentLandsAt(docketDir, c.id)} - the board's next sitting reads every .log in the docket`,
        );
      if (!compact && inst?.instance)
        lines.push(`     credentials: vault-minted for ${inst.instance} through the local MCP shell (value-blind), never this PC's own`);
    }
  } else {
    lines.push(`CONVENE: nothing - this reads as a ${docket.class}; answer it directly (recall below still applies).`);
  }
  for (const step of docket.firstSteps || []) lines.push(`FIRST STEP: ${step.note}`);
  lines.push(...haveForLines(docket, compact ? 6 : 12));
  lines.push(...renderConnections(docket.connections, { compact }));
  const dg = docket.delegation;
  lines.push(`DELEGATION: ${dg.tier} - ${dg.why}`);
  if (dg.backend)
    lines.push(
      `DELEGATE VIA: ${dg.backend} (orchestrator ${dg.orchestrator}, selection ${dg.selection}, profile ${dg.profile}) - hswarm_run { cwd, tools, tasks: [{ id, prompt, profile: "${dg.profile}" }] }; escalation: stay on profile "${dg.profile}" and ${dg.fallback.charAt(0).toLowerCase()}${dg.fallback.slice(1)} (why-not-hswarm required; policy ${dg.policy})`,
    );
  for (const m of docket.models || []) lines.push(`MODEL: ${m.id} thinks on ${m.label} - ${m.why}`);
  if (docket.also.length) lines.push(`YOU ALSO HAVE: ${docket.also.map((a) => `${a.id} (${a.p})`).join(" · ")}`);
  // A trial signal has no vote yet; the full docket says what it would change, so a reader sees it earn one (or not).
  for (const [signal, t] of compact ? [] : Object.entries(docket.votes?.trial || {})) {
    const moved = [...t.added.map((id) => `+${id}`), ...t.dropped.map((id) => `-${id}`)];
    lines.push(`TRIAL ${signal} (no vote yet): ${moved.length ? `if it voted, ${moved.join(" ")}` : "would convene the same"}`);
  }
  // Why a likely instrument stayed home: every filtered or capped one, and any bar miss Jev leaned toward (p >= 0.4).
  const whyHome = (docket.home || []).filter((h) => h.stage !== "bar" || h.p >= 0.4);
  if (!compact && whyHome.length) lines.push(`KEPT HOME:`, ...whyHome.map((h) => `  ${homeLine(h)}`));
  if (docket.memories?.length) {
    lines.push(...memoryLines(docket, compact ? 5 : 10));
  } else if (docket.memoriesBeside) {
    lines.push(
      `MEMORIES: in the <dredd-memories> block beside this docket (the running MCP recalls them); memory_search { query } in-session when it is absent.`,
    );
  } else if (docket.memorySource) {
    lines.push(`MEMORIES: none matched (${docket.memorySource}).`);
  }
  if (docket.peers) {
    const p = docket.peers;
    lines.push(`PEERS: ${p.summary}`);
  }
  // A local MCP that would not open took the lane, the boards and SUE's vault credentials with it; say so and why.
  if (docket.mcpError) lines.push(`MCP: ${docket.mcpError}`);
  if (docket.results?.length) {
    lines.push(`RESULTS:`);
    for (const r of docket.results)
      lines.push(`  ${r.id.padEnd(17)} ${r.status}${r.note ? ` - ${r.note}` : ""}${r.log ? `  → ${r.log}` : ""}`);
  }
  if (docket.hearing) {
    const H = docket.hearing;
    lines.push(`LADDER:`, ...renderLadder(H.ladder || []));
    if (H.seats) lines.push(`SEATS (${H.seats.decidedBy}, ${H.seats.room} room): ${H.seats.picked.join(", ")}`);
    if (H.sittings?.length)
      lines.push(`SITTINGS: ${H.sittings.map((s) => `${s.sitting}${s.proposal ? ` (proposal)` : ""}: ${scoreText(s)}`).join(" · ")}`);
    lines.push(`RESOLUTION: ${H.happy ? "happy" : "not happy"} - ${H.resolution}`);
    if (docketDir) lines.push(`Verdict: ${docketDir}/verdict.md`);
  }
  if (compact) {
    // A docket that sends visitors names --chat, so the chat reading it runs the whole tribunal, SUE included.
    const field = (docket.convene || []).some((c) => c.id === "sue" || c.id === "focus-group" || c.id === "ape" || c.id === "art");
    lines.push(
      `Full hearing: node dredd/dredd.mjs --hearing --docket ${docketDir || "<dir>"}${field ? " --chat --detach" : ""}   ` +
        `(${field ? "--chat: this chat drives SUE's visitors on its own Sonnet 5.5 agents - --status names their briefs; " : ""}manual: dredd/README.md)`,
    );
  } else if (docketDir) {
    lines.push(`Docket: ${docketDir}`);
  }
  return lines.join("\n");
}

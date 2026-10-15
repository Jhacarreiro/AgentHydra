/**
 * depth.spec - the review depth dial: how many reviewers a diff gets, and the scope block that keeps them on it.
 * ==============================================================================================================
 *
 * WHAT: `node --test dredd/tests/depth.spec.mjs`. depthFor's size bands and risk steps, the docs-only cap, the
 * removed-behavior seat that sits only when lines are deleted, the hunter cap and its disjoint regions, a forced level,
 * the scope block's keep-or-discard, measureDiff's numstat reading (injected git), which dockets carry the dial, and
 * the `--review-depth` door end to end over a scratch repository.
 *
 * WHY: a review seat was one generic reviewer or a fixed army whatever the diff; the dial makes cost follow risk with
 * hard caps, and each test below would pass with the dial gone only if the behaviour it names were not there.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { UsageError, parseArgs } from "../dredd.mjs";
import { depthFor, keepScoped, measureDiff, regionsFor, renderDepth, riskOf, scopeBlock, wantsReviewDepth } from "../lib/depth.mjs";

const DREDD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dredd.mjs");
const scratch = mkdtempSync(path.join(os.tmpdir(), "dredd-depth-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** n files under one folder, each with `added` and `deleted` lines. */
const files = (n, { added = 1, deleted = 0, dir = "services/web/src" } = {}) =>
  Array.from({ length: n }, (_, i) => ({ path: `${dir}/f${i}.ts`, added, deleted }));

test("size alone sets the level, and each level's caps are the dial's", () => {
  const low = depthFor({ files: files(2, { added: 10 }) });
  assert.equal(low.depth, "low");
  assert.equal(low.subagents, 0, "low is the main agent alone");
  const medium = depthFor({ files: files(5, { added: 30 }) });
  assert.equal(medium.depth, "medium");
  assert.equal(medium.hunters, 1);
  assert.equal(medium.seats.length, 0);
  assert.equal(depthFor({ files: files(20, { added: 30 }) }).depth, "high");
  assert.equal(depthFor({ files: files(40, { added: 50 }) }).depth, "xhigh");
  const max = depthFor({ files: files(40, { added: 100 }) });
  assert.equal(max.depth, "max");
  assert.equal(max.hunters, 6);
  assert.equal(max.verifier, "per-candidate");
});

test("risky code raises a small diff: one kind by one level, two kinds by two", () => {
  const one = depthFor({ files: [{ path: "services/studio/migrations/0060_x.sql", added: 5, deleted: 0 }] });
  assert.equal(one.depth, "medium");
  assert.ok(one.diff.risk.migration);
  const two = depthFor({
    files: [
      { path: "services/studio/migrations/0060_x.sql", added: 5, deleted: 0 },
      { path: "services/studio/api/auth/verify.ts", added: 5, deleted: 0 },
    ],
  });
  assert.equal(two.depth, "high");
  assert.deepEqual(Object.keys(two.diff.risk).sort(), ["auth", "migration"]);
});

test("a docs-only diff never needs the army, whatever its size", () => {
  const d = depthFor({ files: files(40, { added: 200, dir: "docs/how-to" }).map((f) => ({ ...f, path: f.path.replace(/\.ts$/, ".md") })) });
  assert.equal(d.depth, "medium");
});

test("the removed-behavior seat sits only when the diff deletes lines; the tests seat takes its chair otherwise", () => {
  const adds = depthFor({ files: files(20, { added: 30 }) });
  assert.deepEqual(
    adds.seats.map((s) => s.id),
    ["correctness", "contracts", "tests"],
  );
  const deletes = depthFor({ files: files(20, { added: 20, deleted: 10 }) });
  assert.ok(deletes.seats.some((s) => s.id === "removed-behavior"));
  assert.match(deletes.seats.find((s) => s.id === "removed-behavior").reads, /invariant/);
});

test("hunters never outnumber the files, and their regions split the diff without overlap", () => {
  const few = depthFor({ files: files(2, { added: 2000 }) });
  assert.equal(few.depth, "max");
  assert.equal(few.hunters, 2, "six hunters over two files is four idle workers");
  const spread = [
    ...files(10, { added: 300, dir: "services/web/src" }),
    ...files(10, { added: 300, dir: "packages/core/src" }),
    ...files(10, { added: 300, dir: "dredd/lib" }),
  ];
  const regions = regionsFor(spread, 3);
  assert.equal(regions.length, 3);
  const all = regions.flatMap((r) => r.paths);
  assert.equal(new Set(all).size, spread.length, "every file in exactly one region");
});

test("a forced level wins and says so; a level the dial does not have is refused", () => {
  const d = depthFor({ files: files(1) }, { forced: "max" });
  assert.equal(d.depth, "max");
  assert.equal(d.forced, true);
  assert.throws(() => depthFor({ files: files(1) }, { forced: "huge" }), /not one of/);
});

test("a result that does not repeat the scope block is discarded, and named", () => {
  const block = scopeBlock({ root: scratch, base: "origin/main" });
  assert.match(block, /git -C ".+" diff origin\/main/);
  const echoed = `${block.replace(/\n/g, "\r\n")}\r\nfinding: off by one`;
  const { kept, discarded } = keepScoped([echoed, { text: "finding from another tree" }], block);
  assert.deepEqual(kept, [echoed]);
  assert.equal(discarded.length, 1);
});

test("measureDiff reads numstat (a binary counts nothing) and counts untracked files", () => {
  writeFileSync(path.join(scratch, "new.txt"), "a\nb\nc");
  const git = (args) => (args[0] === "diff" ? "3\t1\tsrc/a.ts\n-\t-\tlogo.png\n" : "new.txt\n");
  const d = measureDiff(scratch, { git });
  assert.deepEqual(d.files, [
    { path: "src/a.ts", added: 3, deleted: 1 },
    { path: "logo.png", added: 0, deleted: 0 },
    { path: "new.txt", added: 3, deleted: 0 },
  ]);
});

test("measureDiff reads at most the cap of untracked files; the rest count one line each, unread", () => {
  writeFileSync(path.join(scratch, "u1.txt"), "a\nb\nc");
  writeFileSync(path.join(scratch, "u2.txt"), "a\nb\nc\nd");
  const git = (args) => (args[0] === "diff" ? "" : "u1.txt\nu2.txt\n");
  const d = measureDiff(scratch, { git, cap: { files: 1, bytes: Infinity } });
  assert.deepEqual(d.files, [
    { path: "u1.txt", added: 3, deleted: 0 },
    { path: "u2.txt", added: 1, deleted: 0 },
  ]);
  const late = measureDiff(scratch, { git, deadline: Date.now() - 1 });
  assert.deepEqual(
    late.files.map((f) => f.added),
    [1, 1],
    "past the deadline no untracked file is read",
  );
});

test("a design-tokens path is not auth; a real auth path still is", () => {
  assert.equal(riskOf(["packages/design-tokens/src/tokens.ts"]).auth, undefined);
  assert.ok(riskOf(["services/studio/api/auth/verify.ts"]).auth);
});

test("the scope block names the untracked files, and the compact line carries a foreign root", () => {
  assert.match(scopeBlock({ root: scratch }), /untracked: git -C ".+" ls-files --others --exclude-standard/);
  const d = { ...depthFor({ files: files(1) }), root: "D:/other/repo" };
  assert.match(renderDepth(d, { compact: true }), /--review-depth --root "D:\/other\/repo"/);
  assert.doesNotMatch(renderDepth(depthFor({ files: files(1) }), { compact: true }), /--root/);
});

test("a code review or complaint docket carries the dial; a page matter and a money matter do not", () => {
  assert.equal(wantsReviewDepth({ class: "review", domain: "code", matter: { kind: "code" } }), true);
  assert.equal(wantsReviewDepth({ class: "complaint", domain: "security", matter: { kind: "code" } }), true);
  assert.equal(wantsReviewDepth({ class: "review", domain: "visual", matter: { kind: "opinion" } }), false);
  assert.equal(wantsReviewDepth({ class: "review", domain: "money", matter: { kind: "code" } }), false);
  assert.equal(wantsReviewDepth({ class: "question", domain: "code", matter: { kind: "code" } }), false);
});

test("the door: --depth is checked, and --base and --depth need --review-depth", () => {
  const a = parseArgs(["--review-depth", "--base", "origin/main", "--depth", "high"]);
  assert.equal(a.reviewDepth, true);
  assert.equal(a.base, "origin/main");
  assert.equal(a.depth, "high");
  assert.throws(() => parseArgs(["--review-depth", "--depth", "huge"]), UsageError);
  assert.throws(() => parseArgs(["--depth", "low", "review this"]), UsageError);
});

test("--review-depth over a real repository prints the decision and the scope block", () => {
  const repo = path.join(scratch, "repo");
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "a.js"), "one\ntwo\nthree\n");
  git("add", "a.js");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  writeFileSync(path.join(repo, "a.js"), "one\n");
  const r = spawnSync(process.execPath, [DREDD, "--root", repo, "--review-depth", "--json"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.depth, "low");
  assert.deepEqual(d.diff, { files: 1, added: 0, deleted: 2, risk: {} });
  assert.match(d.scope, /^REVIEW SCOPE/);
  const bad = spawnSync(process.execPath, [DREDD, "--root", repo, "--review-depth", "--base", "no-such-ref"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^dredd: --review-depth: /);
});

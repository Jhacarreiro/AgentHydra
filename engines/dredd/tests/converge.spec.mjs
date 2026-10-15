/**
 * converge.spec - the convergence ruling: the ask's requirements against the diff, each gap a traced task.
 * ========================================================================================================
 *
 * WHAT: `node --test dredd/tests/converge.spec.mjs`. The pure ruling (lib/converge.mjs) on fixed asks and diffs,
 * the door's --converge flags, and workingDiff over a throwaway git repository (the one seam that reads git).
 *
 * WHY: agents drift from a clearly stated ask, and an agent's own ticked task is a claim, not evidence. Each test pins
 * one promise the ruling makes to the build loop that runs on it: every requirement gets an id, each of the four gap
 * classes is found and traced to its source, a tick never counts as done, and ruling again appends no duplicate task.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { UsageError, convergeRuling, parseArgs, workingDiff } from "../dredd.mjs";
import { appendTasks, converge, extractRequirements, parseDiff, stem } from "../lib/converge.mjs";
import { reapAfterEach } from "./_scratch.mjs";

const scratchDirs = reapAfterEach([]);

const ASK = `# Contacts export
- FR-001: Export contacts as CSV from the contacts page
- FR-002: The export must not call external telemetry
- SC-001: Export includes phone and email columns
`;

const DIFF = `diff --git a/src/contacts/export.mjs b/src/contacts/export.mjs
--- a/src/contacts/export.mjs
+++ b/src/contacts/export.mjs
@@ -1 +1,3 @@
+export function exportContactsCsv(rows) { return rows.map((r) => [r.email].join(",")); }
+sendExternalTelemetry("export");
diff --git a/src/billing/stripe.mjs b/src/billing/stripe.mjs
--- a/src/billing/stripe.mjs
+++ b/src/billing/stripe.mjs
@@ -1 +1 @@
+const invoiceRounding = 2;
`;

test("explicit requirement ids win, a heading is never one, and a plain list numbers its items R1, R2", () => {
  assert.deepEqual(
    extractRequirements(ASK).map((r) => r.id),
    ["FR-001", "FR-002", "SC-001"],
  );
  assert.deepEqual(
    extractRequirements("## Ask\n- add a dark theme toggle\n- keep the settings page fast").map((r) => r.id),
    ["R1", "R2"],
  );
  const [, forbidding] = extractRequirements(ASK);
  assert.deepEqual(forbidding.forbids, ["external", "telemetry"], "what follows 'must not' is what the diff must not add");
  assert.deepEqual(
    extractRequirements("- S3 uploads resume after a dropped connection\n- add a retry button to the upload dialog").map((r) => r.id),
    ["R1", "R2"],
    "a product name shaped like an id is not one, so no other list item is dropped",
  );
  assert.deepEqual(
    extractRequirements("- Export contacts without reloading the page")[0].forbids,
    [],
    "'without' describes, it does not forbid",
  );
});

test("the ruling finds each gap class, traces it to its source, and a ticked task is named a claim", () => {
  const r = converge({ ask: ASK, diff: DIFF, tasks: "- [x] T1 FR-001 export\n- [x] T2 SC-001 columns\n" });
  assert.equal(r.verdict, "not converged");
  const byClass = Object.fromEntries(r.findings.map((f) => [f.class, f]));
  assert.equal(byClass.contradicts.ref, "FR-002");
  assert.match(byClass.contradicts.evidence, /sendExternalTelemetry/);
  assert.equal(byClass.partial.ref, "SC-001");
  assert.match(byClass.partial.evidence, /claim, not evidence/);
  assert.equal(byClass.unrequested.ref, "src/billing/stripe.mjs");
  assert.equal(r.requirements.find((q) => q.id === "FR-001").status, "met");
  assert.deepEqual(
    r.tasks.map((t) => /^- \[ \] \[(\w+)\] (\S+?):/.exec(t).slice(1).join(" ")),
    ["contradicts FR-002", "partial SC-001", "unrequested src/billing/stripe.mjs"],
  );

  const none = converge({ ask: "- FR-009: Archive stale invoices nightly", diff: "", tasks: "- [x] FR-009 done" });
  assert.equal(none.findings[0].class, "missing");
  assert.match(none.findings[0].evidence, /claim, not evidence/);
});

test("a diff that carries every requirement and touches nothing else is converged", () => {
  const ask = "- FR-001: Export contacts from the contacts page";
  const diff =
    "diff --git a/src/contacts/page.mjs b/src/contacts/page.mjs\n+++ b/src/contacts/page.mjs\n+export const exportContacts = () => page.rows;\n";
  const r = converge({ ask, diff });
  assert.equal(r.verdict, "converged");
  assert.deepEqual(r.tasks, []);
});

test("include, includes and included meet at one stem, so an inflection is never a missing term", () => {
  assert.equal(stem("include"), stem("includes"));
  assert.equal(stem("included"), stem("including"));
});

test("appending the ruling twice leaves one open task per gap", () => {
  const r = converge({ ask: ASK, diff: DIFF });
  const once = appendTasks("- [x] T1 FR-001 export\n", r.tasks, { date: "2026-09-24" });
  assert.equal(once.appended, 3);
  assert.match(once.text, /## Convergence \(2026-09-24\)/);
  const twice = appendTasks(once.text, r.tasks, { date: "2026-09-25" });
  assert.equal(twice.appended, 0);
  assert.equal(twice.text, once.text);
});

test("the door takes --converge with --tasks, --append and --base, and refuses them anywhere else", () => {
  const a = parseArgs(["--converge", "--ask-file", "spec.md", "--tasks", "tasks.md", "--append", "--base", "origin/main"]);
  assert.equal(a.converge, true);
  assert.equal(a.tasks, "tasks.md");
  assert.equal(a.base, "origin/main");
  assert.throws(() => parseArgs(["an ask", "--tasks", "tasks.md"]), UsageError);
  assert.throws(() => parseArgs(["--converge", "--append"]), UsageError);
});

test("workingDiff carries a changed tracked file and a new untracked one, never an ignored one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dredd-converge-"));
  scratchDirs.push(dir);
  const git = (...argv) => assert.equal(spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8" }).status, 0, argv.join(" "));
  git("init", "-q");
  writeFileSync(path.join(dir, ".gitignore"), "out/\nignored.txt\n");
  writeFileSync(path.join(dir, "tracked.mjs"), "export const a = 1;\n");
  git("add", ".");
  git("-c", "user.name=spec", "-c", "user.email=spec@example.invalid", "commit", "-qm", "base");
  writeFileSync(path.join(dir, "tracked.mjs"), "export const a = 2;\n");
  writeFileSync(path.join(dir, "fresh.mjs"), "export const fresh = true;\n");
  writeFileSync(path.join(dir, "ignored.txt"), "noise\n");
  const files = parseDiff(workingDiff(dir, "HEAD"));
  assert.deepEqual(files.map((f) => f.file).sort(), ["fresh.mjs", "tracked.mjs"]);
  assert.ok(files.find((f) => f.file === "fresh.mjs").added.includes("export const fresh = true;"));
});

test("the ask file and the tasks file are never evidence, so a spec and its appended tasks alone never converge", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dredd-converge-"));
  scratchDirs.push(dir);
  const git = (...argv) => assert.equal(spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8" }).status, 0, argv.join(" "));
  git("init", "-q");
  const tasks = path.join(dir, "tasks.md");
  writeFileSync(tasks, "# Tasks\n");
  git("add", ".");
  git("-c", "user.name=spec", "-c", "user.email=spec@example.invalid", "commit", "-qm", "base");
  const ask = "- FR-001: Archive stale invoices nightly\n- FR-002: The archive job must not delete paid invoices\n";
  const askFile = path.join(dir, "spec.md");
  writeFileSync(askFile, ask);
  writeFileSync(tasks, '# Tasks\n\n- [ ] [missing] FR-001: implement "Archive stale invoices nightly"\n');
  const { r } = convergeRuling(dir, { ask, askFile, tasks, append: true });
  assert.equal(r.verdict, "not converged");
  assert.equal(r.requirements.find((q) => q.id === "FR-001").status, "missing");
  assert.deepEqual(
    r.findings.filter((f) => f.class === "contradicts" || f.class === "unrequested"),
    [],
    "the spec's own 'must not' line is not a contradiction, and neither input is scope creep",
  );
});

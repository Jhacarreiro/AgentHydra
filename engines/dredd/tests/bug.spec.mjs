/**
 * bug.spec - a bug docket demands its repro, and its fix is ruled verified, partial or failed.
 * ===========================================================================================
 *
 * WHAT: `node --test dredd/tests/bug.spec.mjs`. The ladder (lib/bug.mjs ruleFix), which dockets are bug complaints
 * and the repro they heard (decideDocket's `bug`), the BUG block the docket prints, and `--rule-fix` end to end, typed
 * and on a repro that ran (`--repro-file` through sue/repro.mjs, `--repro-check` as a command).
 *
 * WHY: a fix called done on green tests while the reported symptom was never run again. Green tests with the original
 * repro not re-run must rule PARTIAL, never verified (the idea: github/spec-kit's bug extension, MIT).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { filedLines, isBugComplaint, routeFiled, ruleFix, statedRepro } from "../lib/bug.mjs";
import { decideDocket, ENGINE_ROOT, heuristicAnswers, loadBench, renderDocket } from "../lib/docket.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DREDD = path.resolve(HERE, "..", "dredd.mjs");

test("the ladder: green tests without the original repro rule partial; only the repro re-run verifies", () => {
  const partial = ruleFix({ reproResult: "not-run", tests: "pass" });
  assert.equal(partial.verdict, "partial");
  assert.equal(partial.downgraded, true);
  assert.equal(ruleFix({ reproResult: "gone", tests: "pass", repro: "clicked save on /notes, the note saved" }).verdict, "verified");
  assert.equal(ruleFix({ reproResult: "gone", tests: "none", repro: "ran bun run export, no stack trace" }).verdict, "verified");
  assert.equal(ruleFix({ reproResult: "still", tests: "pass", repro: "clicked save, it still crashed" }).verdict, "failed");
  assert.equal(ruleFix({ reproResult: "gone", tests: "fail", repro: "clicked save, it saved" }).verdict, "failed");
  assert.equal(ruleFix({ reproResult: "not-run", tests: "none" }).downgraded, false);
});

test("a repro claimed as run must say what ran; a bad value is refused by name", () => {
  assert.throws(() => ruleFix({ reproResult: "gone", tests: "pass" }), /needs --repro/);
  assert.throws(() => ruleFix({ reproResult: "gone", tests: "pass", repro: "fixed" }), /three words at least/);
  assert.throws(() => ruleFix({ reproResult: "maybe", tests: "green" }), /--repro-result is one of[\s\S]*--tests is one of/);
});

// A SUE visitor's typed problem (sue/report.mjs filedList) is routed where it is settled, and sue.log says how.
test("a SUE visitor's typed problem is routed by its rubric: a 4-5 issue to a repro, a warning to the critic, the rest to the room", () => {
  const p = (severity, defect) => ({ severity, defect });
  const rubric = [p(5, "issue"), p(4, "issue"), p(3, "issue"), p(1, "issue"), p(2, "warning"), p(1, "warning")];
  assert.deepEqual(
    [...rubric, { defect: "issue" }, p(4.5, "issue"), null].map((row) => routeFiled(row)),
    ["repro", "repro", "room", "room", "design-critic", "design-critic", null, null, null],
  );
  const runId = "20261008-140000-ab12";
  const filed = [
    {
      ref: "sue-1118-grandma:7",
      sueId: "sue-1118-grandma",
      page: "https://learn.test/demo/lesson/2?from=save",
      look: "look-0009.jpg",
      title: "Lesson progress is lost after Save says Saved",
      defect: "issue",
      severity: 5,
      expected: "After Save says Saved, reopening Lesson 2 shows my answers",
      actual: 'Lesson 2 opens at "Start lesson" with "0% done"',
      steps: ["Open the class link", 'Click "Lesson 2"'],
      quoted: true,
      seen: 2,
    },
    {
      ref: "sue-1119-kai:6",
      sueId: "sue-1119-kai",
      page: "https://learn.test/pricing",
      look: "look-0004.jpg",
      title: "Price label overlaps the Buy button on a phone",
      defect: "warning",
      severity: 2,
      seen: 1,
    },
    {
      ref: "sue-1120-jo:5",
      sueId: "sue-1120-jo",
      page: "https://learn.test/search",
      title: "Search ignores the second word",
      defect: "issue",
      severity: 3,
      seen: 1,
    },
  ];
  // The run's own folder (SUE_HOME moved it here), so the paths open from wherever the log is read.
  const runDir = `D:\\sue-home\\runs\\${runId}`;
  const lines = filedLines(filed, { runId, runDir });
  assert.deepEqual(lines.slice(0, 8), [
    "Problems the visitors filed, worst first (routed by lib/bug.mjs routeFiled):",
    '- REPRO [5 issue] "Lesson progress is lost after Save says Saved" on /demo/lesson/2, seen by 2 (sue-1118-grandma:7)',
    '    expected: After Save says Saved, reopening Lesson 2 shows my answers | actual: Lesson 2 opens at "Start lesson" with "0% done" (quoted from her screen)',
    '    steps: 1. Open the class link 2. Click "Lesson 2"',
    `    write a repro that asserts the expected and fails on the actual (her moves are in D:/sue-home/runs/${runId}/sue-1118-grandma/trace.jsonl), then:`,
    `    node sue/repro.mjs confirm ${runId} --finding sue-1118-grandma:7 --repro <file>`,
    `- DESIGN CRITIC [2 warning] "Price label overlaps the Buy button on a phone" on /pricing (sue-1119-kai:6, her look: D:/sue-home/runs/${runId}/sue-1119-kai/shots/look-0004.jpg)`,
    '- ROOM [3 issue] "Search ignores the second word" on /search (sue-1120-jo:5)',
  ]);
  assert.match(
    filedLines([filed[1]], { runId })[1],
    new RegExp(`her look: sue/runs/${runId}/sue-1119-kai/shots/look-0004\\.jpg\\)$`),
    "with no run folder known, SUE's default one, from the checkout root the confirm command runs in",
  );
  assert.deepEqual(
    lines.slice(8).map((line) => line.split(":")[0].trim()),
    ["REPRO", "DESIGN CRITIC", "ROOM"],
    "each route used says once why it goes there",
  );
  assert.deepEqual(filedLines([], { runId }), []);
  assert.deepEqual(filedLines(undefined, { runId }), [], "a run before typed problems logs nothing new");
});

test("a bug complaint files its repro; a copy complaint and new work that names a bug word do not", () => {
  assert.equal(isBugComplaint({ ask: "the export crashes when I click save", askClass: "complaint" }), true);
  assert.equal(isBugComplaint({ ask: "fix the crash on save", askClass: "build" }), true);
  assert.equal(isBugComplaint({ ask: "build a crash reporter", askClass: "build" }), false);
  assert.equal(isBugComplaint({ ask: "the pricing page copy is way too wordy", askClass: "complaint" }), false);
  assert.equal(statedRepro("the export crashes when I click save. Please fix."), "when I click save");
  assert.equal(statedRepro("`bun run export --all` throws"), "bun run export --all");
  assert.equal(statedRepro("login is broken"), null);
  // A pasted handoff is material, not the person's complaint: its "Broken for users 8" files no bug, and the command it
  // quotes is no repro (2026-10-02, a handoff's `bun run save ...` became a bug docket's repro). Their own words still do.
  const handoff =
    '<pasted_content id="h1">\nHANDOFF\n- land with `bun run save -- -m "..." -- <paths>`\n- Live: Broken for users 8\n</pasted_content>';
  assert.equal(isBugComplaint({ ask: handoff, askClass: "complaint" }), false);
  assert.equal(statedRepro(handoff), null);
  const withLog = `the export crashes every time I click save\n${handoff}`;
  assert.equal(isBugComplaint({ ask: withLog, askClass: "complaint" }), true);
  assert.equal(statedRepro(withLog), "every time I click save");

  const bench = loadBench(ENGINE_ROOT);
  const ask = "the notes export crashes every time the user clicks save";
  const docket = decideDocket({ bench, ask, answers: heuristicAnswers(bench, ask), source: "heuristic" });
  assert.deepEqual(docket.bug, { repro: "every time the user clicks save", verdicts: ["verified", "partial", "failed"] });
  const text = renderDocket({ ...docket, id: "d1" }, bench, { compact: true });
  assert.match(text, /BUG: a fix is ruled verified, partial or failed/);
  assert.match(text, /REPRO heard: "every time the user clicks save"/);
  assert.match(text, /--rule-fix d1 --repro/);

  const copy = "the pricing page copy is way too wordy";
  assert.equal(decideDocket({ bench, ask: copy, answers: heuristicAnswers(bench, copy), source: "heuristic" }).bug, undefined);
});

test("end to end: --rule-fix keeps the ruling in docket.json, downgrades green tests, and refuses a bare claim", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dredd-bug-"));
  try {
    const env = { ...process.env, DREDD_NO_RECORD: "1" };
    const out = path.join(repo, "tmp", "dredd", "20260924-120000-bug1");
    const run = (args) => spawnSync(process.execPath, [DREDD, "--root", repo, ...args], { encoding: "utf8", timeout: 60_000, env });
    const filed = run([
      "--out",
      out,
      "--no-jev",
      "--no-recall",
      "--no-peers",
      "--no-catalog",
      "the settings page is broken when I click save",
    ]);
    assert.equal(filed.status, 0, filed.stderr);
    assert.match(filed.stdout, /BUG: a fix is ruled/);

    const partial = run(["--rule-fix", out, "--repro-result", "not-run", "--tests", "pass"]);
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(partial.stdout, /ruled PARTIAL/);
    assert.match(partial.stdout, /green tests alone never verify/);
    assert.equal(JSON.parse(readFileSync(path.join(out, "docket.json"), "utf8")).fix.verdict, "partial");

    const verified = run(["--rule-fix", out, "--repro", "clicked save on settings, it saved", "--repro-result", "gone", "--tests", "pass"]);
    assert.equal(verified.status, 0, verified.stderr);
    const fix = JSON.parse(readFileSync(path.join(out, "docket.json"), "utf8")).fix;
    assert.equal(fix.verdict, "verified");
    assert.deepEqual(
      fix.history.map((h) => h.verdict),
      ["partial"],
    );

    const bare = run(["--rule-fix", out, "--repro-result", "gone", "--tests", "pass"]);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /needs --repro/);
    const stray = run(["--tests", "pass", "an ask"]);
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /only go with --rule-fix/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The executable form: the repro RUNS (sue/repro.mjs for a file, any command for --repro-check) and the ruling
// takes its result from the run, never from a typed sentence. A repro broken on something other than its assertion
// re-ran nothing, so it rules as not-run. The claim-to-bug rule is tester-army/e2e's bug-bash reference (Apache-2.0).
test("end to end: --repro-file and --repro-check rule the fix on a repro that ran", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "dredd-bug-ran-"));
  try {
    const env = { ...process.env, DREDD_NO_RECORD: "1" };
    const out = path.join(repo, "tmp", "dredd", "20261002-120000-bug2");
    const run = (args) => spawnSync(process.execPath, [DREDD, "--root", repo, ...args], { encoding: "utf8", timeout: 120_000, env });
    const fixOf = () => JSON.parse(readFileSync(path.join(out, "docket.json"), "utf8")).fix;
    const filed = run([
      "--out",
      out,
      "--no-jev",
      "--no-recall",
      "--no-peers",
      "--no-catalog",
      "the cart total is broken when I add two items",
    ]);
    assert.equal(filed.status, 0, filed.stderr);
    assert.match(filed.stdout, /--repro-file <repro\.mjs>/, "the BUG block names the executable form");

    const repro = (name, body) => {
      const file = path.join(repo, name);
      writeFileSync(file, `import assert from "node:assert/strict";\n${body}\n`, "utf8");
      return file;
    };
    const still = repro("still.mjs", "assert.equal(9.99 + 9.99 + 1, 19.98);");
    const gone = repro("gone.mjs", "assert.equal(9.99 + 9.99, 19.98);");
    const broken = repro("broken.mjs", 'throw new Error("no button named Add to cart");');

    const failed = run(["--rule-fix", out, "--repro-file", still, "--tests", "pass"]);
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(failed.stdout, /ruled FAILED/);
    assert.match(failed.stdout, /the repro ran: still/);
    assert.deepEqual((({ verdict, reproResult }) => ({ verdict, reproResult }))(fixOf()), { verdict: "failed", reproResult: "still" });
    assert.equal(fixOf().executed.form, "file");
    assert.equal(fixOf().executed.target, still);

    const partial = run(["--rule-fix", out, "--repro-file", broken, "--tests", "pass"]);
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(partial.stdout, /ruled PARTIAL/);
    assert.match(partial.stdout, /counts as not run/);
    assert.equal(fixOf().reproResult, "not-run");
    assert.equal(fixOf().executed.result, "broken-test");

    const verified = run(["--rule-fix", out, "--repro-file", gone, "--tests", "pass"]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(fixOf().verdict, "verified");
    assert.deepEqual(
      fixOf().history.map((h) => h.verdict),
      ["failed", "partial"],
    );

    const node = JSON.stringify(process.execPath);
    const checkStill = run(["--rule-fix", out, "--repro-check", `${node} -e "process.exit(1)"`, "--tests", "none"]);
    assert.equal(checkStill.status, 0, checkStill.stderr);
    assert.equal(fixOf().verdict, "failed");
    assert.equal(fixOf().executed.form, "check");
    const checkGone = run(["--rule-fix", out, "--repro-check", `${node} -e "process.exit(0)"`, "--tests", "none"]);
    assert.equal(checkGone.status, 0, checkGone.stderr);
    assert.equal(fixOf().verdict, "verified");

    const both = run(["--rule-fix", out, "--repro-file", gone, "--repro-check", "exit 0", "--tests", "pass"]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /give one/);
    const typedToo = run(["--rule-fix", out, "--repro-file", gone, "--repro-result", "gone", "--tests", "pass"]);
    assert.equal(typedToo.status, 2);
    assert.match(typedToo.stderr, /drop --repro and --repro-result/);
    const stray = run(["--repro-file", gone, "an ask"]);
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /only go with --rule-fix/);
    const typed = run(["--rule-fix", out, "--repro", "added two items, the total was right", "--repro-result", "gone", "--tests", "pass"]);
    assert.equal(typed.status, 0, typed.stderr);
    assert.equal(fixOf().verdict, "verified", "the typed form keeps working");
    assert.equal(fixOf().executed, undefined, "a typed ruling records no run");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

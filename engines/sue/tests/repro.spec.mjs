/**
 * repro.spec.mjs - a SUE finding is a claim until a repro asserting the right behaviour fails on that assertion.
 * ===========================================================================================================
 *
 * WHAT: `node --test sue/tests/repro.spec.mjs`. Three tiny repros (no browser: the classification is about
 * how a script ENDS, not what it drives) prove sue/repro.mjs's three results and their exit codes - an
 * AssertionError is still (1), any other error, a hang or a repro that exits by itself is broken-test (3), a pass
 * is gone (0) - and that confirm, triage and check write and read the run's repro.json as documented.
 *
 * WHY: the line between a real bug and a model's complaint is mechanical only if a failing setup step (a control
 * that is not there) can never pass for a reproduced bug, and a passing repro can never confirm one. The idea is
 * tester-army/e2e's bug-bash reference (Apache-2.0), steps 5 and 6; written fresh.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classifyRun, findingFacts, parseFindingRef, reproSections } from "../lib/repro.mjs";
import { EXIT, main, runRepro } from "../repro.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPRO_CLI = path.join(TESTS_DIR, "..", "repro.mjs");

const scratch = mkdtempSync(path.join(os.tmpdir(), "sue-repro-spec-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A repro script in the scratch folder. */
function repro(name, body) {
  const file = path.join(scratch, name);
  writeFileSync(file, `import assert from "node:assert/strict";\n${body}\n`, "utf8");
  return file;
}

// The bug: the cart total is wrong. The repro asserts the RIGHT total, so it fails on that assertion.
const STILL = repro("still.mjs", 'const total = 19.98 + 1;\nassert.equal(total, 19.98, "the cart total is the sum of its items");');
// The repro is wrong: the control it waits for does not exist, which is not the bug.
const BROKEN = repro("broken.mjs", 'throw new Error("locator.click: no button named Save on the page");');
// The fix landed (or the bug never was): every assertion holds.
const GONE = repro("gone.mjs", "assert.equal(9.99 + 9.99, 19.98);");
const EXITS = repro("exits.mjs", "process.exit(0);");
const HANGS = repro("hangs.mjs", "setInterval(() => {}, 1000);\nawait new Promise(() => {});");

const quiet = () => {
  const lines = [];
  return { lines, log: (s) => lines.push(s) };
};

test("classifyRun: an assertion is still, any other throw or no outcome is broken-test, a pass is gone", () => {
  const assertion = {
    outcome: "threw",
    name: "AssertionError",
    code: "ERR_ASSERTION",
    message: "Expected values to be strictly equal:\n\n2 !== 1",
  };
  assert.equal(classifyRun({ exitCode: 1, record: assertion }).result, "still");
  assert.match(classifyRun({ exitCode: 1, record: assertion }).why, /2 !== 1/);
  assert.equal(
    classifyRun({ exitCode: 1, record: { outcome: "threw", name: "TimeoutError", message: "waiting for Save" } }).result,
    "broken-test",
  );
  assert.equal(classifyRun({ exitCode: 0, record: { outcome: "passed" } }).result, "gone");
  assert.equal(classifyRun({ exitCode: 0, record: null }).result, "broken-test", "a repro that ended the process itself proved nothing");
  assert.equal(classifyRun({ timedOut: true, timeoutS: 5, record: { outcome: "passed" } }).result, "broken-test");
});

test("runRepro: the three tiny repros end still, broken-test and gone", async () => {
  const still = await runRepro(STILL, { timeoutS: 60 });
  assert.equal(still.result, "still", still.output);
  assert.match(still.why, /the assertion failed/);
  assert.equal((await runRepro(BROKEN, { timeoutS: 60 })).result, "broken-test");
  assert.equal((await runRepro(GONE, { timeoutS: 60 })).result, "gone");
  assert.equal((await runRepro(EXITS, { timeoutS: 60 })).result, "broken-test");
  const hung = await runRepro(HANGS, { timeoutS: 2 });
  assert.equal(hung.result, "broken-test");
  assert.match(hung.why, /timed out after 2 s/);
});

// The engine store's closure check imports every module it carries: imported, the child must do nothing.
test("importing lib/repro-child.mjs neither throws, exits nor adds a process-wide handler", async () => {
  const events = ["uncaughtException", "unhandledRejection"];
  const before = events.map((event) => process.listeners(event));
  const realExit = process.exit;
  let exited = null;
  process.exit = (code) => {
    exited = code;
    throw new Error(`process.exit(${code}) on import`);
  };
  let added;
  try {
    await import(pathToFileURL(path.join(TESTS_DIR, "..", "lib", "repro-child.mjs")).href);
  } finally {
    process.exit = realExit;
    // Take back whatever the import added, so a failing case cannot end the rest of this file.
    added = events.flatMap((event, i) =>
      process
        .listeners(event)
        .filter((listener) => !before[i].includes(listener))
        .map((listener) => (process.off(event, listener), event)),
    );
  }
  assert.equal(exited, null, "the import exited the process");
  assert.deepEqual(added, [], "the import added process-wide handlers");
});

test("run and check: the exit codes are the documented ones, and check exits 0 only on gone", async () => {
  assert.deepEqual(EXIT, { gone: 0, still: 1, "broken-test": 3 });
  for (const [file, code] of [
    [STILL, 1],
    [BROKEN, 3],
    [GONE, 0],
  ]) {
    const { log } = quiet();
    assert.equal(await main(["run", file], { log }), code, file);
    assert.equal(await main(["check", file], { log }), code, file);
  }
  const { lines, log } = quiet();
  await main(["run", GONE, "--json"], { log });
  assert.deepEqual(Object.keys(JSON.parse(lines.at(-1))).sort(), ["exitCode", "file", "ms", "result", "why"]);
  assert.equal(JSON.parse(lines.at(-1)).result, "gone");
  // The CLI itself, as 4man's check and Dredd's --repro-file run it.
  const cli = (file) => spawnSync(process.execPath, [REPRO_CLI, "check", file], { encoding: "utf8", timeout: 60_000 });
  assert.equal(cli(GONE).status, 0);
  assert.equal(cli(STILL).status, 1);
  assert.equal(cli(BROKEN).status, 3);
});

test("confirm and triage write repro.json: confirmed only on still, a re-ruling replaces the entry and keeps its history", async () => {
  const runsDir = path.join(scratch, "runs");
  const runDir = path.join(runsDir, "run-1");
  mkdirSync(path.join(runDir, "sue-1-grandma"), { recursive: true });
  const rows = [
    { kind: "broken", text: "The total says 20.98 for two 9.99 items.", url: "https://example.com/cart", severity: 3 },
    { kind: "annoyance", text: "Nothing happened when I clicked Save.", url: "https://example.com/settings", severity: 2 },
  ];
  writeFileSync(path.join(runDir, "sue-1-grandma", "findings.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const at = ["--runs-dir", runsDir];
  const ledger = () => JSON.parse(readFileSync(path.join(runDir, "repro.json"), "utf8")).entries;

  assert.equal(await main(["confirm", "run-1", "--finding", "sue-1-grandma:1", "--repro", STILL, ...at], quiet()), 0);
  const confirmed = ledger().find((e) => e.finding === "sue-1-grandma:1");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.repro, path.resolve(STILL), "the repro is recorded absolute, so the check runs from any folder");
  assert.equal(confirmed.page, "https://example.com/cart");
  assert.match(confirmed.said, /20\.98/);
  assert.ok(confirmed.at);

  assert.equal(await main(["confirm", "run-1", "--finding", "sue-1-grandma:2", "--repro", GONE, ...at], quiet()), 1);
  assert.deepEqual((({ status, reason }) => ({ status, reason }))(ledger().find((e) => e.finding === "sue-1-grandma:2")), {
    status: "rejected",
    reason: "not-reproduced",
  });
  assert.equal(await main(["confirm", "run-1", "--finding", "sue-1-grandma:2", "--repro", BROKEN, ...at], quiet()), 1);
  assert.equal(ledger().find((e) => e.finding === "sue-1-grandma:2").reason, "broken-test");

  const why = "the settings page saves on blur by design, per its copy";
  assert.equal(await main(["triage", "run-1", "--finding", "sue-1-grandma:2", "--bucket", "design", "--why", why, ...at], quiet()), 0);
  const triaged = ledger().filter((e) => e.finding === "sue-1-grandma:2");
  assert.equal(triaged.length, 1, "one entry per finding");
  assert.equal(triaged[0].bucket, "design");
  assert.equal(triaged[0].why, why);
  assert.deepEqual(
    triaged[0].history.map((h) => h.group),
    ["not-reproduced", "broken-test"],
  );

  const sections = reproSections(runDir);
  assert.deepEqual(
    sections.confirmed.map((e) => e.finding),
    ["sue-1-grandma:1"],
  );
  assert.deepEqual(
    sections.rejected.map((g) => [g.group, g.label, g.entries.length]),
    [["design", "Design", 1]],
  );
});

// A typed problem (lib/findings.mjs problemNote) keeps its claim through a ruling, so repro.json and the report name
// what was proved or rejected; a row written before typed problems reads exactly as it did.
test("a typed finding keeps its problem through confirm and triage, and an old row carries only its page and words", async () => {
  const runsDir = path.join(scratch, "runs-typed");
  const runDir = path.join(runsDir, "run-3");
  mkdirSync(path.join(runDir, "sue-3-kai"), { recursive: true });
  const problem = {
    title: "The total is wrong for two items",
    defect: "issue",
    severity: 4,
    expected: "Two 9.99 items cost 19.98",
    actual: 'The total says "20.98"',
    steps: ["Add two 9.99 items", "Open the cart"],
    look: "look-0004.jpg",
    quoted: true,
    n: 1,
    ref: "sue-3-kai:1",
  };
  const typed = { kind: "broken", text: "that total is wrong", url: "https://example.com/cart", problem };
  writeFileSync(
    path.join(runDir, "sue-3-kai", "findings.jsonl"),
    `${JSON.stringify(typed)}\n${JSON.stringify({ ...typed, problem: undefined })}\n`,
  );
  const claim = {
    title: problem.title,
    defect: "issue",
    severity: 4,
    expected: problem.expected,
    actual: problem.actual,
    steps: problem.steps,
    look: "look-0004.jpg",
  };
  assert.deepEqual(findingFacts(typed), { page: "https://example.com/cart", said: "that total is wrong", problem: claim });
  assert.deepEqual(findingFacts({ kind: "broken", text: "old", url: "https://example.com/cart" }), {
    page: "https://example.com/cart",
    said: "old",
  });

  const at = ["--runs-dir", runsDir];
  const ledger = () => JSON.parse(readFileSync(path.join(runDir, "repro.json"), "utf8")).entries;
  assert.equal(await main(["confirm", "run-3", "--finding", "sue-3-kai:1", "--repro", STILL, ...at], quiet()), 0);
  assert.deepEqual(ledger().find((e) => e.finding === "sue-3-kai:1").problem, claim);
  const why = "the seed prices both items at 10.49 on purpose";
  assert.equal(await main(["triage", "run-3", "--finding", "sue-3-kai:1", "--bucket", "fixture", "--why", why, ...at], quiet()), 0);
  assert.deepEqual(ledger().find((e) => e.finding === "sue-3-kai:1").problem, claim, "a re-ruling keeps the claim it ruled on");
  assert.equal(await main(["confirm", "run-3", "--finding", "sue-3-kai:2", "--repro", STILL, ...at], quiet()), 0);
  assert.equal("problem" in ledger().find((e) => e.finding === "sue-3-kai:2"), false, "an untyped finding's entry is as it always was");
});

test("confirm and triage refuse what they cannot record (exit 2), and record nothing", async () => {
  const runsDir = path.join(scratch, "runs-refused");
  const runDir = path.join(runsDir, "run-2");
  mkdirSync(path.join(runDir, "sue-2-bob"), { recursive: true });
  writeFileSync(path.join(runDir, "sue-2-bob", "findings.jsonl"), `${JSON.stringify({ kind: "drop", text: "left", severity: 3 })}\n`);
  const at = ["--runs-dir", runsDir];
  assert.equal(await main(["confirm", "run-2", "--finding", "sue-2-bob:9", "--repro", STILL, ...at], quiet()), 2, "no such line");
  assert.equal(await main(["confirm", "no-run", "--finding", "sue-2-bob:1", "--repro", STILL, ...at], quiet()), 2, "no such run");
  assert.equal(
    await main(["triage", "run-2", "--finding", "sue-2-bob:1", "--bucket", "taste", "--why", "it is fine really", ...at], quiet()),
    2,
  );
  assert.equal(await main(["triage", "run-2", "--finding", "sue-2-bob:1", "--bucket", "fixture", "--why", "seed", ...at], quiet()), 2);
  assert.equal(await main(["run", path.join(scratch, "nope.mjs")], quiet()), 2);
  assert.equal(reproSections(runDir), null, "a refused command leaves no repro.json");
  assert.throws(() => parseFindingRef("../sue-2-bob:1"));
  assert.throws(() => parseFindingRef("sue-2-bob:0"));
  assert.deepEqual(parseFindingRef("sue-2-bob:1"), { sue: "sue-2-bob", line: 1 });
});

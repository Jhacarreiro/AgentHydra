/**
 * price.spec - the Price check instrument, with nothing spawned but a stub CLI.
 * ============================================================================
 *
 * WHAT: `node --test dredd/tests/price.spec.mjs`. The bench entry `price` wraps the pricecheck CLI; its
 * placeholders fill (`{pricecheckCli}`, `{repo}`); it runs in a repo it did not come from; it convenes on
 * page clutter and not on a backend failure or a copy-tone-only ask; a wrong rating reports the bad advice
 * to pricecheck, and a missing CLI never fails the rating.
 *
 * WHY: the price is a fact about a page's files, so the instrument must judge the repo it is convened for
 * (not the Connections target), and a wrong price must reach pricecheck's ratchet as feedback without ever
 * blocking the rating that Dredd is graded on.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decideDocket, fillRun, heuristicAnswers, loadBench, runnableIn } from "../lib/docket.mjs";
import { pricecheckCli, priceFeedbackFor, reportPriceFeedback } from "../lib/price.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bench = loadBench(ROOT);
const price = bench.instruments.find((i) => i.id === "price");

function withEnv(name, value, fn) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

function convenedIds(ask) {
  const docket = decideDocket({ bench, ask, answers: heuristicAnswers(bench, ask), source: "heuristic" });
  return docket.convene.map((c) => c.id);
}

test("price is a bench instrument that scores the judged repo with the pricecheck CLI, a JSON file and a log", () => {
  assert.ok(price, "the bench has a price instrument");
  assert.equal(price.mode, "now");
  assert.match(price.run, /^node \{pricecheckCli\} scan --root \{repo\}/);
  assert.match(price.run, /\{docket\}\/price\.json/);
  assert.match(price.evidence, /price\.json/);
  assert.ok(price.jev.endsWith("?"), "a yes-or-no question for Jev");
  for (const word of ["busy", "too long", "confusing", "cut it down", "simplify"]) {
    assert.ok(price.keywords.some((k) => k.includes(word)), `keyword ${word}`);
  }
});

test("fillRun resolves {pricecheckCli} from PRICECHECK_CLI, else this repo's own pricecheck, and {repo} to the judged repo", () => {
  withEnv("PRICECHECK_CLI", "D:/tools/pc.mjs", () => {
    const line = fillRun(price.run, { docketDir: "D:/d/x", repo: "D:/work/shop", shell: "sh" });
    assert.ok(line.includes("D:/tools/pc.mjs"), line);
    assert.ok(line.includes("D:/work/shop"), line);
    assert.ok(!line.includes("{pricecheckCli}") && !line.includes("{repo}"), line);
  });
  withEnv("PRICECHECK_CLI", undefined, () => {
    assert.equal(pricecheckCli(), path.join(ROOT, "pricecheck", "bin", "pricecheck.mjs"));
  });
});

test("price runs in a repo it did not come from: the CLI is this machine's, the repo is whatever is judged", () => {
  const foreign = mkdtempSync(path.join(os.tmpdir(), "price-foreign-"));
  try {
    const verdict = runnableIn(price, { root: foreign, engineRoot: ROOT, scripts: {}, exists: () => false });
    assert.equal(verdict.ok, true, verdict.why);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("price convenes on page clutter and not on a backend failure", () => {
  assert.ok(convenedIds("the catalog page is way too busy, cut it down").includes("price"));
  assert.ok(!convenedIds("the payments webhook is failing").includes("price"));
});

test("a bare clutter word is the Design Critic's, as the layout ask in docket.spec has it", () => {
  assert.ok(!convenedIds("the pricing page layout is cluttered on desktop").includes("price"));
});

test("a desktop app window stays home even in price's own words: there is no web page code to price", () => {
  assert.ok(convenedIds("the settings page is way too busy, cut it down").includes("price"));
  assert.ok(!convenedIds("the WPF app's settings window is way too busy, cut it down").includes("price"));
});

test("price does not convene on a copy-tone-only ask", () => {
  assert.ok(!convenedIds("the headline tone is off, make it warmer").includes("price"));
});

test("a wrong price rating writes the bad advice to pricecheck, with the price claim and the rating's reason", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "price-fb-"));
  try {
    const stub = path.join(dir, "stub.mjs");
    const argv = path.join(dir, "argv.json");
    writeFileSync(
      stub,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    writeFileSync(
      path.join(dir, "price.json"),
      JSON.stringify({ root: "D:/work/shop", mode: "static", pages: [{ page: "src/views/Catalog.vue", file: "src/views/Catalog.vue", points: 300, units: {}, byFile: {} }] }),
    );
    const docket = { id: "d1", convene: [{ id: "price" }], ask: "the catalog page is way too busy" };
    const rating = { choices: { price: "wrong" }, note: "the catalog is a grid the shopper scans, not a wall of text" };
    const result = priceFeedbackFor({ docket, rating, docketDir: dir, root: "D:/work/shop", cli: stub });
    assert.equal(result.ok, true, result.why);
    assert.deepEqual(JSON.parse(readFileSync(argv, "utf8")), [
      "feedback",
      "--verdict",
      "wrong",
      "--claim",
      "src/views/Catalog.vue is the dearest page at 300 points",
      "--why",
      "the catalog is a grid the shopper scans, not a wall of text",
      "--by",
      "dredd",
      "--root",
      "D:/work/shop",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no feedback unless price was rated wrong, and a missing CLI never throws", () => {
  const docket = { id: "d2", convene: [{ id: "price" }], ask: "x" };
  assert.equal(priceFeedbackFor({ docket, rating: { choices: { price: "right" }, note: "" }, docketDir: ".", root: "." }), null);
  const missing = reportPriceFeedback({ cli: path.join(os.tmpdir(), "no-such-pricecheck.mjs"), claim: "c", why: "w", root: "." });
  assert.equal(missing.ok, false);
});

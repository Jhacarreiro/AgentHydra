#!/usr/bin/env node
import { targetRoot } from "../lib/target.mjs";
// dredd/recall-bench.mjs - which recall path finds the answer, and for how many tokens? (lib/recall-bench.mjs)
//
//   node dredd/recall-bench.mjs [--live [--record-reads]] [--verbose] [--json]
//
// By default the hand-written questions (eval/recall-bench/questions.json) run against a SYNTHETIC memory fixture
// (eval/recall-bench/memories.json) through a lexical stand-in for memory_search, so the numbers are reproducible and
// no real memory enters the repo. --live runs the same questions through this machine's local MCP instead, read-only:
// only the grep path runs (memory_search { contains } records no read). The query paths (memory_search, docket, hook)
// RECORD a read on every hit, which ages memory_prune's staleness signal and can ratify a tentative memory, so they run
// live only with a second opt-in, --record-reads, and the header says so. With no MCP configured, every path is skipped
// with the reason. Prints slugs and numbers only, never a memory body.
//
// An instrument, not a gate: it exits 0 whatever the scores, and non-zero only when it crashes. A floor is the
// owner's to set.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openLocalMcp } from "./lib/mcp.mjs";
import { benchPaths, fixtureLane, hookFires, PATHS, reportLines, runBench, summarize } from "./lib/recall-bench.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = targetRoot();
const FIXTURE = path.join(HERE, "eval", "recall-bench");

const LIVE = process.argv.includes("--live");
const RECORD_READS = LIVE && process.argv.includes("--record-reads");
const VERBOSE = process.argv.includes("--verbose");
const JSON_OUT = process.argv.includes("--json");

const { questions } = JSON.parse(readFileSync(path.join(FIXTURE, "questions.json"), "utf8"));
const fixture = JSON.parse(readFileSync(path.join(FIXTURE, "memories.json"), "utf8"));
const answerable = questions.filter((q) => q.answer !== null).length;
const { run: paths, skipped: skippedPaths } = benchPaths({ live: LIVE, recordReads: RECORD_READS });

let backend;
let mcp = null;
let skipped = null;
if (LIVE) {
  try {
    mcp = await openLocalMcp({ root: ROOT, timeoutMs: 25_000, clientName: "dredd-recall-bench" });
    backend = {
      // A query records a read, so without --record-reads the live lane refuses it outright, whatever path asks.
      search: RECORD_READS
        ? (query, limit) => mcp.call("memory_search", { query, limit })
        : async () => ({ ok: false, text: "refused: a query records a read; --record-reads not given" }),
      contains: (text, limit) => mcp.call("memory_search", { contains: text, limit }),
    };
  } catch (err) {
    skipped = `no local memory lane: ${String(err?.message || err).slice(0, 200)}`;
  }
} else backend = fixtureLane(fixture.memories, { repo: fixture.repo });

const header = [
  `DREDD RECALL BENCH - ${questions.length} questions (${answerable} answerable, ${questions.length - answerable} that no memory answers), ${LIVE ? "LIVE: this machine's memory lane" : `synthetic fixture of ${fixture.memories.length} memories`}`,
  "A small, hand-written set: read it as a comparison between paths, not as a measure of recall in production.",
  ...(LIVE
    ? [
        RECORD_READS
          ? `Live with --record-reads: THIS WRITES TO YOUR STORE. Every query hit on ${PATHS.filter((p) => p.recordsReads)
              .map((p) => p.id)
              .join(", ")} records a read (staleness for memory_prune, and it can ratify a tentative memory).`
          : `Live, read-only: only ${paths.map((p) => p.id).join(", ")} runs (memory_search { contains } records no read); the query paths are skipped, add --record-reads to run them and record their reads.`,
        "Live: hit@5 counts only questions with a recorded liveAnswer (none yet), so the live columns that mean something are tokens and ms.",
        "Live: absent->none means something only on the synthetic fixture; the real lane always returns its top-k rows, so a query path scores 0% on it.",
      ]
    : ["Synthetic: the ranker is a lexical (BM25) stand-in for memory_search, not its Titan embeddings; ms is in-process, no network."]),
  `Tokens: characters / 4 of what the path hands its reader. The prompt hook's gate fires on ${hookFires(questions)} of these questions; the hook row scores its recall as if it fired.`,
];

if (skipped) {
  const out = { live: LIVE, skipped, paths: PATHS.map((p) => p.id) };
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  else console.log([...header, "", ...PATHS.map((p) => `${p.id.padEnd(14)} skipped: ${skipped}`)].join("\n"));
} else {
  try {
    const results = await runBench(questions, backend, { paths, answerKey: LIVE ? "liveAnswer" : "answer" });
    const summary = summarize(results);
    if (JSON_OUT)
      console.log(
        JSON.stringify({ live: LIVE, recordReads: RECORD_READS, summary, skippedPaths, results: VERBOSE ? results : undefined }, null, 2),
      );
    else {
      const lines = [...header, "", ...reportLines(summary, paths), ...skippedPaths.map((p) => `  ${p.id}: skipped, ${p.reason}`)];
      if (VERBOSE) {
        lines.push("", "PER QUESTION (path, id, verdict, tokens, ms, top slugs):");
        for (const r of results) {
          const verdict = !r.ok ? `FAILED ${r.error}` : !r.grade.scored ? "unscored" : r.grade.correct ? "right" : "wrong";
          lines.push(
            `  ${r.path.padEnd(14)} ${r.id}  ${verdict.padEnd(9)} ${String(r.tokens).padStart(5)} tok ${String(r.ms).padStart(7)} ms  ${r.top.join(", ") || "(none)"}`,
          );
        }
      }
      console.log(lines.join("\n"));
    }
  } finally {
    await mcp?.close();
  }
}

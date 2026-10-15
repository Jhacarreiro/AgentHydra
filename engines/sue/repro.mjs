#!/usr/bin/env node
/**
 * repro.mjs - turn a SUE finding from a claim into a bug, or out of the queue: run its repro, record the ruling.
 * ===========================================================================================================
 *
 * WHAT: a SUE visitor's finding is a model's CLAIM. It becomes a bug only when a repro - an ESM node script that
 * drives the page with playwright-core and asserts the CORRECT behaviour with node:assert - fails on the assertion
 * that encodes the bug. Any other failure (a missing control, a timeout, a crash) means the repro is wrong, and a
 * pass means the bug did not reproduce. Once the bug is fixed the same repro passes, and it stays as the check that
 * proves the fix (4man's SUE scout files a confirmed finding with `check` as the check). The rules and repro.json
 * live in lib/repro.mjs; the child that imports a repro is lib/repro-child.mjs.
 *
 *   node sue/repro.mjs run <file> [--timeout <s>] [--json]
 *       runs the repro and classifies it. exit 0 gone (it passed), 1 still (an AssertionError: the bug
 *       reproduces), 3 broken-test (any other error, a timeout, or the repro ending the process itself), 2 usage.
 *       Prints `<result>: <why>`; --json prints { result, why, file, ms, exitCode }.
 *   node sue/repro.mjs check <file> [--timeout <s>]
 *       the command that proves a fix: exit 0 ONLY when the repro passes (gone); 1 still, 3 broken-test, 2 usage.
 *   node sue/repro.mjs confirm <run id> --finding <sue folder>:<line> --repro <file> [--timeout <s>] [--runs-dir <dir>]
 *       runs the repro and records into runs/<run id>/repro.json { finding, repro (absolute), status, at }: status
 *       confirmed only on still, else rejected with reason not-reproduced (gone) or broken-test. exit 0 confirmed,
 *       1 rejected (recorded either way), 2 usage or no such finding in that run.
 *   node sue/repro.mjs triage <run id> --finding <sue folder>:<line> --bucket environment|design|fixture|sue-side
 *          --why "<what settled it>" [--runs-dir <dir>]
 *       records a reject bucket before any repro is written. exit 0 recorded, 2 usage.
 *
 * A repro's contract: top-level await is the whole test; it throws, never catches its own failure or calls
 * process.exit; setup steps wait with playwright (their timeout is a broken test, as it should be) and only the
 * assertions that encode the bug use node:assert; it closes its browser in a finally. Chromium runs under node,
 * never bun, so this file and its child do too.
 *
 * WHY / CREDIT: the claim-to-bug rule and the reject buckets are tester-army/e2e's bug-bash reference (Apache-2.0),
 * steps 5 and 6. Written fresh for SUE; nothing of theirs is copied.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/shared/is-main-module.mjs";
import {
  BUCKETS,
  classifyRun,
  confirmEntry,
  findingAt,
  findingFacts,
  parseFindingRef,
  recordEntry,
  REPRO_REJECTS,
  triageEntry,
} from "./lib/repro.mjs";
import { runsRoot } from "./lib/run-dir.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib", "repro-child.mjs");
export const DEFAULT_TIMEOUT_S = 120;
/** The exit code of each result, for run and check. */
export const EXIT = { gone: 0, still: 1, "broken-test": 3 };

class UsageError extends Error {}

/** End a process and what it started (a repro's browser): the whole tree on Windows. */
function killTree(child) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  } else {
    child.kill("SIGKILL");
  }
}

/**
 * Run one repro under node and classify it. Never throws for a repro's own failure.
 * @returns {Promise<{ result: string, why: string, file: string, ms: number, exitCode: number|null, output: string }>}
 */
export async function runRepro(file, { timeoutS = DEFAULT_TIMEOUT_S, cwd = process.cwd(), env = process.env } = {}) {
  const abs = path.resolve(cwd, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new UsageError(`no repro file at ${abs}`);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "sue-repro-"));
  const outcomeFile = path.join(scratch, "outcome.json");
  // Under bun, process.execPath is bun: a repro drives Chromium, which runs under node.
  const node = process.versions.bun ? "node" : process.execPath;
  const started = Date.now();
  try {
    const { exitCode, timedOut, output } = await new Promise((resolve) => {
      const child = spawn(node, [CHILD, abs, outcomeFile], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const keep = (chunk) => {
        output = (output + chunk).slice(-8000);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutS * 1000);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, timedOut, output: `${output}\n${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut, output });
      });
    });
    let record = null;
    try {
      record = JSON.parse(readFileSync(outcomeFile, "utf8"));
    } catch {
      // no outcome: classifyRun names it
    }
    const { result, why } = classifyRun({ timedOut, timeoutS, exitCode, record });
    return { result, why, file: abs, ms: Date.now() - started, exitCode, output };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = { cmd, positional: [], timeoutS: DEFAULT_TIMEOUT_S, json: false };
  const value = (i, flag) => {
    if (i >= rest.length) throw new UsageError(`${flag} needs a value`);
    return rest[i];
  };
  for (let i = 0; i < rest.length; i += 1) {
    const x = rest[i];
    if (x === "--json") a.json = true;
    else if (x === "--timeout") {
      a.timeoutS = Number(value(++i, x));
      if (!Number.isFinite(a.timeoutS) || a.timeoutS <= 0) throw new UsageError(`--timeout takes seconds above 0, not "${rest[i]}"`);
    } else if (x === "--finding") a.finding = value(++i, x);
    else if (x === "--repro") a.repro = value(++i, x);
    else if (x === "--bucket") a.bucket = value(++i, x);
    else if (x === "--why") a.why = value(++i, x);
    else if (x === "--runs-dir") a.runsDir = value(++i, x);
    else if (x === "--help" || x === "-h") a.help = true;
    else if (/^--/.test(x)) throw new UsageError(`unknown flag ${x}`);
    else a.positional.push(x);
  }
  return a;
}

const USAGE = `usage:
  node sue/repro.mjs run <file> [--timeout <s>] [--json]          exit 0 gone, 1 still, 3 broken-test
  node sue/repro.mjs check <file> [--timeout <s>]                 exit 0 only when the repro passes
  node sue/repro.mjs confirm <run id> --finding <sue>:<line> --repro <file> [--timeout <s>] [--runs-dir <dir>]
  node sue/repro.mjs triage <run id> --finding <sue>:<line> --bucket ${Object.keys(BUCKETS).join("|")} --why "<what settled it>" [--runs-dir <dir>]`;

/** The run folder and the finding row a confirm or triage names; refuses a run or a line that is not there. */
function runAndFinding(a) {
  const runId = a.positional[0];
  if (!runId) throw new UsageError(`${a.cmd} needs a run id`);
  if (!a.finding) throw new UsageError(`${a.cmd} needs --finding <sue folder>:<line>`);
  try {
    parseFindingRef(a.finding);
  } catch (err) {
    throw new UsageError(err.message);
  }
  const runDir = path.join(a.runsDir ? path.resolve(a.runsDir) : runsRoot(), runId);
  if (!existsSync(runDir)) throw new UsageError(`no SUE run ${runId} at ${runDir}`);
  const row = findingAt(runDir, a.finding);
  if (!row) throw new UsageError(`no finding ${a.finding} in run ${runId}: that line of her findings.jsonl is absent or not JSON`);
  return { runDir, ...findingFacts(row) };
}

/** One command; returns the exit code. Exported so the specs can drive it in-process too. */
export async function main(argv, { log = (s) => process.stdout.write(`${s}\n`) } = {}) {
  let a;
  try {
    a = parseArgs(argv);
    if (a.help || !a.cmd) {
      log(USAGE);
      return a.help ? 0 : 2;
    }
    if (a.cmd === "run" || a.cmd === "check") {
      const file = a.positional[0];
      if (!file) throw new UsageError(`${a.cmd} needs a repro file`);
      const run = await runRepro(file, { timeoutS: a.timeoutS });
      if (a.json) log(JSON.stringify({ result: run.result, why: run.why, file: run.file, ms: run.ms, exitCode: run.exitCode }));
      else if (a.cmd === "check")
        log(run.result === "gone" ? `FIXED (gone): ${run.why} - ${run.file}` : `NOT FIXED (${run.result}): ${run.why} - ${run.file}`);
      else log(`${run.result}: ${run.why}`);
      if (run.result === "broken-test" && !a.json && run.output.trim()) log(run.output.trim().split(/\r?\n/).slice(-12).join("\n"));
      return EXIT[run.result];
    }
    if (a.cmd === "confirm") {
      if (!a.repro) throw new UsageError("confirm needs --repro <file>");
      const { runDir, page, said, problem } = runAndFinding(a);
      const run = await runRepro(a.repro, { timeoutS: a.timeoutS });
      const entry = recordEntry(runDir, confirmEntry({ finding: a.finding, repro: run.file, run, page, said, problem }));
      if (entry.status === "confirmed") {
        log(`CONFIRMED ${a.finding}: ${run.why}`);
        log(`  recorded in ${path.join(runDir, "repro.json")}; once fixed, prove it with: node sue/repro.mjs check "${run.file}"`);
        return 0;
      }
      log(`REJECTED ${a.finding} (${entry.reason}): ${run.why}`);
      log(`  ${REPRO_REJECTS[entry.reason]}; recorded in ${path.join(runDir, "repro.json")}`);
      return 1;
    }
    if (a.cmd === "triage") {
      const { runDir, page, said, problem } = runAndFinding(a);
      let entry;
      try {
        entry = triageEntry({ finding: a.finding, bucket: a.bucket, why: a.why, page, said, problem });
      } catch (err) {
        throw new UsageError(err.message);
      }
      recordEntry(runDir, entry);
      log(`REJECTED ${a.finding} into ${entry.bucket} (${BUCKETS[entry.bucket]}): ${entry.why}`);
      return 0;
    }
    throw new UsageError(`unknown command ${a.cmd}`);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`repro: ${err.message}\n${USAGE}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.main, import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`repro: ${err?.stack || err}\n`);
      process.exitCode = 2;
    },
  );
}

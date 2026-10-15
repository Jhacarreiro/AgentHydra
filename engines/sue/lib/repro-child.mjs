/**
 * repro-child - the process a repro runs in: import it, and write down how it ended.
 * ================================================================================
 *
 * `node lib/repro-child.mjs <repro file> <outcome file>`, started only by sue/repro.mjs. It imports the
 * repro (its top-level await is the whole test), then writes { outcome: "passed" } or { outcome: "threw", name,
 * code, message } to the outcome file and exits, which also ends a browser the repro left open. A repro that ends
 * the process itself leaves no outcome file, and lib/repro.mjs classifyRun calls that a broken test.
 *
 * It does all of that only when node started it as the main script. Imported (the engine store's closure check
 * imports every module it carries) it does nothing: no argv read, no process-wide handler, no exit.
 *
 * The idea this serves (a finding is a bug only when an assertion of the correct behaviour fails) is
 * tester-army/e2e's bug-bash reference (Apache-2.0); written fresh for SUE.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../../lib/shared/is-main-module.mjs";

function runChild([file, outcomeFile]) {
  let settled = false;

  function finish(outcome, err) {
    if (settled) return;
    settled = true;
    const record = { outcome };
    if (err !== undefined) {
      record.name = String(err?.name ?? typeof err);
      if (err?.code !== undefined) record.code = String(err.code);
      record.message = String(err?.message ?? err).slice(0, 4000);
    }
    try {
      writeFileSync(outcomeFile, JSON.stringify(record), "utf8");
    } catch {
      // no outcome file: the parent classifies the run as a broken test, which it is
    }
    if (err !== undefined) process.stderr.write(`${err?.stack || err}\n`);
    process.exit(outcome === "passed" ? 0 : 1);
  }

  process.on("uncaughtException", (err) => finish("threw", err));
  process.on("unhandledRejection", (err) => finish("threw", err));

  import(pathToFileURL(path.resolve(file)).href).then(
    () => finish("passed"),
    (err) => finish("threw", err),
  );
}

if (isMainModule(import.meta.main, import.meta.url)) runChild(process.argv.slice(2));

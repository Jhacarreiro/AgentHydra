/**
 * run-dir.spec - the global Sue counter hands out distinct numbers when many processes ask at once.
 * ==================================================================================================
 *
 * WHAT: `node --test sue/tests/run-dir.spec.mjs`. Starts eight node processes at the same moment
 * under one temp `SUE_HOME`, each taking five numbers, and asserts all forty are different and the
 * counter ends forty past the owner's 1117. Also: a lock left behind by a dead process is broken.
 *
 * WHY IT EXISTS: on 2026-09-22 MonkeyWerx started eight cannons in one second (one persona each) and
 * one died at launch in `nextSueNumber` with EPERM from the rename; the unlocked read-and-advance could
 * also hand two Sues the same number, which is the same address in the ledger.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUN_DIR = pathToFileURL(
  path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "lib", "run-dir.mjs"),
).href;

function taker(home, count) {
  const script = `import { nextSueNumber } from ${JSON.stringify(RUN_DIR)};
const got = []; for (let i = 0; i < ${count}; i += 1) got.push(nextSueNumber());
process.stdout.write(JSON.stringify(got));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, SUE_HOME: home },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
  });
}

test("eight processes started together never share a Sue number", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-counter-"));
  try {
    const all = (await Promise.all(Array.from({ length: 8 }, () => taker(home, 5)))).flat();
    assert.equal(all.length, 40);
    assert.equal(new Set(all).size, 40, `duplicates handed out: ${all.sort().join(",")}`);
    const counter = JSON.parse(fs.readFileSync(path.join(home, "state", "counter.json"), "utf8"));
    assert.equal(counter.next, 1117 + 40);
    assert.equal(fs.existsSync(path.join(home, "state", "counter.json.lock")), false, "the lock is released");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a lock left by a process that died holding it is broken, not waited on forever", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-counter-"));
  try {
    const lock = path.join(home, "state", "counter.json.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.deepEqual(await taker(home, 1), [1117]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("taking a number keeps every field a newer Sue wrote into the counter", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-counter-"));
  try {
    const file = path.join(home, "state", "counter.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ next: 2000, updatedAt: "2026-09-25T00:00:00Z", byMachine: { a: 3 } }));
    assert.deepEqual(await taker(home, 1), [2000]);
    const counter = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(counter.next, 2001);
    assert.deepEqual(counter.byMachine, { a: 3 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * atomic-json.spec - concurrent writers of one file on Windows, and the leftovers a stop or a crash leaves.
 * ==========================================================================================
 *
 * WHAT: a rename that fails twice with EPERM still writes the file and leaves no temp; one that never succeeds
 * deletes its own temp and throws; `sweepPeopleFiles` and `sue stop` remove a stopped run's own target copy and
 * an orphan `.tmp`, and leave a running run's copy alone. Everything under a temp SUE_HOME and temp workspace.
 *
 * WHY IT EXISTS: 2026-10-03, eight `sue run` calls on one page section: one died on `EPERM ... rename` and left
 * its .tmp, and seven `run.<runId>.target.json` copies outlived their stopped runs.
 *
 * Also: a write of the bytes the file already holds touches nothing (side-by-side runs write one target).
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import "./fixtures/people.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { dispatch, sweepPeopleFiles } from "../sue.mjs";
import { stateRoot } from "../lib/run-dir.mjs";

const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const eperm = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

test("a rename that fails twice with EPERM still writes the file and leaves no temp", () => {
  const dir = tempDir("sue-atomic-");
  try {
    const file = path.join(dir, "target.json");
    let failures = 2;
    const waits = [];
    const io = {
      ...fs,
      writeFileSync: fs.writeFileSync,
      rmSync: fs.rmSync,
      renameSync(from, to) {
        if (failures-- > 0) throw eperm();
        fs.renameSync(from, to);
      },
    };
    writeJsonAtomic(file, { a: 1 }, { io, sleep: (ms) => waits.push(ms) });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
    assert.equal(waits.length, 2);
    assert.deepEqual(fs.readdirSync(dir), ["target.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rename that never succeeds gives up within about two seconds and deletes its own temp", () => {
  const dir = tempDir("sue-atomic-");
  try {
    const file = path.join(dir, "target.json");
    const waits = [];
    const io = {
      ...fs,
      writeFileSync: fs.writeFileSync,
      rmSync: fs.rmSync,
      renameSync: () => {
        throw eperm();
      },
    };
    assert.throws(() => writeJsonAtomic(file, { a: 1 }, { io, sleep: (ms) => waits.push(ms) }), { code: "EPERM" });
    assert.ok(waits.reduce((a, b) => a + b, 0) <= 2100, `waited ${waits}`);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rename error that is not a Windows lock is thrown at once, not retried", () => {
  const dir = tempDir("sue-atomic-");
  try {
    const waits = [];
    const io = {
      ...fs,
      writeFileSync: fs.writeFileSync,
      rmSync: fs.rmSync,
      renameSync: () => {
        throw Object.assign(new Error("x"), { code: "ENOENT" });
      },
    };
    assert.throws(() => writeJsonAtomic(path.join(dir, "t.json"), {}, { io, sleep: (ms) => waits.push(ms) }), { code: "ENOENT" });
    assert.equal(waits.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writing the bytes the file already holds never writes a temp or renames", () => {
  const dir = tempDir("sue-atomic-");
  try {
    const file = path.join(dir, "target.json");
    writeJsonAtomic(file, { a: 1 });
    let renames = 0;
    let writes = 0;
    const io = {
      ...fs,
      readFileSync: fs.readFileSync,
      writeFileSync: (...args) => {
        writes += 1;
        return fs.writeFileSync(...args);
      },
      renameSync: (...args) => {
        renames += 1;
        return fs.renameSync(...args);
      },
    };
    writeJsonAtomic(file, { a: 1 }, { io, sleep: () => {} });
    assert.equal(renames, 0);
    assert.equal(writes, 0);
    assert.deepEqual(fs.readdirSync(dir), ["target.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writing different bytes over an existing file still writes them", () => {
  const dir = tempDir("sue-atomic-");
  try {
    const file = path.join(dir, "target.json");
    writeJsonAtomic(file, { a: 1 });
    let renames = 0;
    const io = {
      ...fs,
      renameSync: (...args) => {
        renames += 1;
        return fs.renameSync(...args);
      },
    };
    writeJsonAtomic(file, { a: 2 }, { io, sleep: () => {} });
    assert.equal(renames, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the sweep removes a stopped run's target copy and an orphan temp, and keeps a running run's copy", () => {
  const mcp = path.join(stateRoot(), "mcp");
  fs.mkdirSync(mcp, { recursive: true });
  const ws = tempDir("sue-sweep-ws-");
  const done = "20260101-000010-dead";
  const live = "20260101-000011-beef";
  const copy = (id) => path.join(ws, `run.${id}.target.json`);
  const deadTmp = path.join(ws, "target.page.json.999999999.tmp");
  const ownTmp = path.join(ws, `target.page.json.${process.pid}.tmp`);
  const stale = path.join(ws, "target.old.json.1.tmp");
  fs.writeFileSync(copy(done), "{}");
  fs.writeFileSync(copy(live), "{}");
  fs.writeFileSync(deadTmp, "{}");
  fs.writeFileSync(ownTmp, "{}");
  fs.writeFileSync(stale, "{}");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  for (const [id, state] of [
    [done, "stopped"],
    [live, "starting"],
  ]) {
    fs.writeFileSync(path.join(mcp, `${id}.spec.json`), JSON.stringify({ runTargetFile: copy(id) }));
    fs.writeFileSync(path.join(mcp, `${id}.status.json`), JSON.stringify({ runId: id, state, at: new Date().toISOString() }));
  }
  try {
    sweepPeopleFiles();
    assert.equal(fs.existsSync(copy(done)), false, "a stopped run's copy goes");
    assert.equal(fs.existsSync(copy(live)), true, "a running run's copy stays");
    assert.equal(fs.existsSync(deadTmp), false, "a temp whose pid is dead goes");
    assert.equal(fs.existsSync(stale), false, "a temp older than an hour goes");
    assert.equal(fs.existsSync(ownTmp), true, "a fresh temp of a live pid stays");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    for (const id of [done, live]) for (const s of ["spec", "status"]) fs.rmSync(path.join(mcp, `${id}.${s}.json`), { force: true });
  }
});

test("sue stop deletes the stopped run's own target copy", () => {
  const mcp = path.join(stateRoot(), "mcp");
  fs.mkdirSync(mcp, { recursive: true });
  const ws = tempDir("sue-stop-ws-");
  const id = "20260101-000020-cafe";
  const copy = path.join(ws, `run.${id}.target.json`);
  fs.writeFileSync(copy, "{}");
  fs.writeFileSync(path.join(mcp, `${id}.spec.json`), JSON.stringify({ runTargetFile: copy }));
  // A runner that is a real, throwaway process the stop may kill (this spec started it).
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  fs.writeFileSync(path.join(mcp, `${id}.status.json`), JSON.stringify({ runId: id, state: "running", pid: child.pid }));
  try {
    assert.equal(dispatch("stop", { workspace: ws, runId: id }).stopped, true);
    assert.equal(fs.existsSync(copy), false);
  } finally {
    child.kill();
    fs.rmSync(ws, { recursive: true, force: true });
    for (const s of ["spec", "status"]) fs.rmSync(path.join(mcp, `${id}.${s}.json`), { force: true });
  }
});

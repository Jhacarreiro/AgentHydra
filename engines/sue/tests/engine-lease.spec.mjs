/**
 * engine-lease.spec - which snapshot of Sue's code a process runs, and the lease it leaves in that
 * snapshot while it runs (lib/engine-lease.mjs).
 * ==========================================================================================
 *
 * WHAT: in the checkout there is no engine and no lease; a snapshot is read off its `.sue-engine.json`
 * and names the checkout it came from; a lease is written the moment a process takes it, names the
 * process's real start (not the moment it took the lease), and is gone once the process exits.
 *
 * WHY IT EXISTS: Owner, 2026-09-25: "someone starts a Sue on 1.14, you push 1.15, all the Sues keep
 * running on 1.14". The store (lib/engine-store.mjs) deletes a snapshot no live process leases; a lease
 * that outlived its process would keep an old snapshot forever, and one whose start time is wrong would
 * let the collector delete the snapshot under a live run (it matches startedAtMs against the OS creation
 * time of the pid, within 10 s).
 *
 * Plain node (`node --test sue/tests/engine-lease.spec.mjs`). Every store is a temp dir.
 */
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkoutRoot, engineInfo, takeLease, writeLease } from "../lib/engine-lease.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEASE_MODULE = pathToFileURL(path.join(HERE, "..", "lib", "engine-lease.mjs")).href;
const REPO = path.resolve(HERE, "..", "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sue-engine-lease-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** A store with one snapshot, `<store>/<id>/sue`, and its manifest naming `checkout`. */
function fakeStore(id = "0123456789abcdef", checkout = "C:/checkouts/connections") {
  const store = fs.mkdtempSync(path.join(ROOT, "sue-engine-store-"));
  const root = path.join(store, id);
  const sueDir = path.join(root, "sue");
  fs.mkdirSync(sueDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, ".sue-engine.json"),
    JSON.stringify({ id, commit: "abcdef1234", checkout, stagedAt: new Date().toISOString() }),
  );
  return { store, root, sueDir, id, checkout };
}

test("in the checkout there is no engine and no lease", () => {
  assert.equal(engineInfo(), null, "this checkout's own sue is not a snapshot");
  assert.equal(takeLease("runner", { runId: "20260925-120000-abcd" }), null);
  assert.equal(fs.existsSync(path.join(REPO, ".leases")), false, "nothing is written beside a checkout");
  assert.equal(checkoutRoot(), REPO);
});

test("a snapshot is read off its manifest: its id, its folder, the node running it and the checkout it came from", () => {
  const { store, root, sueDir, id, checkout } = fakeStore();
  try {
    assert.deepEqual(engineInfo(sueDir), { id, root, exe: process.execPath });
    assert.equal(checkoutRoot(sueDir), path.resolve(checkout));
    fs.rmSync(path.join(root, ".sue-engine.json"));
    assert.equal(engineInfo(sueDir), null, "a folder whose manifest is not written yet is not a snapshot");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// 2026-09-25, two skeptics on this PC: a lease written just after the store collected its snapshot made
// the id's folder again (mkdir recursive), holding only .leases, and every stage of that id then failed.
test("a lease is never written into a snapshot the store has collected, and never makes its folder again", () => {
  const { store, root } = fakeStore();
  try {
    fs.rmSync(root, { recursive: true, force: true });
    assert.throws(() => writeLease(root, { pid: 4242, startedAtMs: Date.now(), role: "runner" }), /not a whole snapshot/);
    assert.equal(fs.existsSync(root), false, "the collected snapshot's folder is not made again");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("a lease names its process's real start, and is gone once that process exits", async () => {
  const { store, root, sueDir } = fakeStore();
  // The child waits 1.5 s before it takes its lease, so a start time read at lease time is caught.
  const script = path.join(store, "lease-holder.mjs");
  fs.writeFileSync(
    script,
    [
      `import { engineInfo, takeLease } from ${JSON.stringify(LEASE_MODULE)};`,
      "await new Promise((resolve) => setTimeout(resolve, 1500));",
      `const file = takeLease("runner", { runId: "20260925-120000-abcd" }, { engine: engineInfo(${JSON.stringify(sueDir)}) });`,
      "process.stdout.write(JSON.stringify({ file, at: Date.now() }) + '\\n');",
      "process.stdin.once('data', () => process.stdin.destroy());",
    ].join("\n"),
  );
  const before = Date.now();
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const said = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
      });
      child.once("exit", (code) => reject(new Error(`the lease holder exited ${code} before it said anything`)));
    });
    assert.equal(said.file, path.join(root, ".leases", `${child.pid}.json`));
    const lease = JSON.parse(fs.readFileSync(said.file, "utf8"));
    assert.equal(lease.pid, child.pid);
    assert.equal(lease.role, "runner");
    assert.equal(lease.runId, "20260925-120000-abcd");
    assert.ok(Number.isFinite(Date.parse(lease.at)), "when it was taken");
    assert.ok(lease.startedAtMs >= before - 1000, `startedAtMs ${lease.startedAtMs} is before the spawn (${before})`);
    assert.ok(said.at - lease.startedAtMs >= 1000, "startedAtMs is when the process started, not when it took the lease");
    if (process.platform === "win32") {
      // The collector checks exactly this: the OS creation time of the pid, within 10 s.
      const asked = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[DateTimeOffset]::new((Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}").CreationDate).ToUnixTimeMilliseconds()`,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 20_000 },
      );
      const created = Number(String(asked.stdout).trim());
      assert.ok(Number.isFinite(created) && created > 0, `the OS said when ${child.pid} started: ${asked.stdout} ${asked.stderr}`);
      assert.ok(Math.abs(created - lease.startedAtMs) <= 10_000, `OS creation ${created} vs startedAtMs ${lease.startedAtMs}`);
    }
    child.stdin.write("bye\n");
    assert.equal(await exited, 0);
    assert.equal(fs.existsSync(said.file), false, "the lease left with its process");
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// Node's own estimate of its start runs late by however long node took to start, which is seconds on a
// loaded box; past 10 s it would read as another process given the same pid, and the collector would
// delete the snapshot under a live run.
test(
  "a long-lived process pins its start to the OS's own creation time, and its lease says exactly that",
  { skip: process.platform !== "win32" },
  async () => {
    const { store, root, sueDir } = fakeStore();
    const script = path.join(store, "pinned-holder.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        `import { engineInfo, pinProcessStart, takeLease } from ${JSON.stringify(LEASE_MODULE)};`,
        // The same one question the store's collector asks (engine-store.mjs processTable).
        `import { processTable } from ${JSON.stringify(LEASE_MODULE.replace(/engine-lease\.mjs$/, "engine-store.mjs"))};`,
        "const os = (await processTable([process.pid])).get(process.pid);",
        "pinProcessStart(os);",
        `const file = takeLease("runner", {}, { engine: engineInfo(${JSON.stringify(sueDir)}) });`,
        "process.stdout.write(JSON.stringify({ os, file, lease: JSON.parse(fs.readFileSync(file, 'utf8')) }) + '\\n');",
      ].join("\n"),
    );
    const asked = spawnSync(process.execPath, [script], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    try {
      assert.ok(String(asked.stdout).trim(), `the holder said nothing: ${asked.stderr}`);
      const said = JSON.parse(String(asked.stdout).trim().split("\n")[0]);
      assert.ok(Number.isFinite(said.os) && said.os > 0, `Windows said when it started: ${asked.stdout} ${asked.stderr}`);
      assert.equal(said.file, path.join(root, ".leases", `${asked.pid}.json`));
      assert.equal(said.lease.startedAtMs, said.os, "the OS's creation time, not node's later estimate");
      assert.equal(fs.existsSync(said.file), false, "gone with its process");
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  },
);

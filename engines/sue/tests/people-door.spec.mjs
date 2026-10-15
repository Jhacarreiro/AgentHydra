// The warm people door: a long-lived local holder of one open door, answering live calls over 127.0.0.1 with a token.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ensureHolder, holderStateFile, startHolder, warmDoor } from "../people-door.mjs";

const TMP = mkdtempSync(path.join(tmpdir(), "sue-people-door-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const fresh = () => mkdtempSync(path.join(TMP, "root-"));

/** A fake door that counts its calls and can be told to die once. */
function fakeOpen({ dieOnce = false, personas = [{ doc: { id: "a" }, updatedAt: "t" }] } = {}) {
  const w = { opened: 0, closed: 0, calls: [], dieOnce };
  w.openDoor = async () => {
    const id = ++w.opened;
    return {
      door: async (tool, body) => {
        w.calls.push({ id, tool, body });
        if (w.dieOnce && id === 1) throw new Error("local MCP stdin: write EPIPE");
        if (tool === "boardroom_personas_sue_list") return { ok: true, status: 200, body: { personas } };
        if (tool === "boardroom_personas_sue_mind") return { ok: true, status: 200, body: { mind: `mind of ${body.sueId}` } };
        return { ok: false, status: 404, body: null, text: `no tool ${tool}` };
      },
      close: async () => {
        w.closed += 1;
      },
    };
  };
  return w;
}

/** A fake clock: timers fire only when the test says so. */
function fakeTimers() {
  const t = { fns: [], cleared: 0 };
  t.ms = [];
  t.set = (fn, ms) => (t.fns.push(fn), t.ms.push(ms), t.fns.length);
  t.clear = () => {
    t.cleared += 1;
  };
  return t;
}

test("the holder answers a list and a minds call through the door it holds, the same objects", async () => {
  const stateDir = fresh();
  const w = fakeOpen();
  const holder = await startHolder({ root: "R", stateDir, openDoor: w.openDoor });
  try {
    const warm = await warmDoor({ root: "R", stateDir });
    assert.ok(warm);
    const list = await warm.door("boardroom_personas_sue_list", { builtIns: true });
    assert.deepEqual(list, { ok: true, status: 200, body: { personas: [{ doc: { id: "a" }, updatedAt: "t" }] } });
    const mind = await warm.door("boardroom_personas_sue_mind", { sueId: "doc" });
    assert.equal(mind.body.mind, "mind of doc");
    assert.deepEqual(
      w.calls.map((c) => c.tool),
      ["boardroom_personas_sue_list", "boardroom_personas_sue_mind"],
    );
    assert.equal(w.opened, 1, "one door held for every call");
    // Never a tool outside the two reads findReuse makes.
    const other = await warm.door("boardroom_personas_sue_save", { personas: [] });
    assert.equal(other.ok, false);
    assert.equal(w.calls.length, 2);
  } finally {
    await holder.close();
  }
});

/** POST to the holder's /door over node:http, as the client does, and answer the status. Not fetch: the spec
 *  harness's network guard refuses every fetch, loopback included. */
const postStatus = (port, headers, body) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/door", method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });

test("a request without the token is refused, and nothing reaches the door", async () => {
  const stateDir = fresh();
  const w = fakeOpen();
  const holder = await startHolder({ root: "R", stateDir, openDoor: w.openDoor });
  try {
    const { port, token } = JSON.parse(readFileSync(holderStateFile("R", { stateDir }), "utf8"));
    const body = JSON.stringify({ tool: "boardroom_personas_sue_list", body: {} });
    const none = await postStatus(port, {}, body);
    const wrong = await postStatus(port, { "x-sue-token": "nope" }, body);
    assert.equal(none, 401);
    assert.equal(wrong, 401);
    assert.deepEqual(w.calls, []);
    const ok = await postStatus(port, { "x-sue-token": token }, body);
    assert.equal(ok, 200);
  } finally {
    await holder.close();
  }
});

test("a door that died is reopened once and the call is answered", async () => {
  const stateDir = fresh();
  const w = fakeOpen({ dieOnce: true });
  const holder = await startHolder({ root: "R", stateDir, openDoor: w.openDoor });
  try {
    const warm = await warmDoor({ root: "R", stateDir });
    const list = await warm.door("boardroom_personas_sue_list", { builtIns: true });
    assert.equal(list.ok, true);
    assert.equal(w.opened, 2);
    assert.equal(w.closed, 1, "the dead door is closed");
    await warm.door("boardroom_personas_sue_list", { builtIns: true });
    assert.equal(w.opened, 2, "reopened once, not again");
  } finally {
    await holder.close();
  }
});

test("a door that dies again on the retry answers a failure, not a loop", async () => {
  const stateDir = fresh();
  const calls = { opened: 0 };
  const openDoor = async () => {
    calls.opened += 1;
    return { door: async () => Promise.reject(new Error("gone")), close: async () => {} };
  };
  const holder = await startHolder({ root: "R", stateDir, openDoor });
  try {
    const warm = await warmDoor({ root: "R", stateDir });
    const answer = await warm.door("boardroom_personas_sue_list", {});
    assert.equal(answer.ok, false);
    assert.equal(calls.opened, 2);
  } finally {
    await holder.close();
  }
});

test("it exits after its idle time and removes its state file; a request keeps it alive", async () => {
  const stateDir = fresh();
  const w = fakeOpen();
  const timers = fakeTimers();
  let exited = 0;
  await startHolder({ root: "R", stateDir, openDoor: w.openDoor, timers, onExit: () => (exited += 1) });
  const file = holderStateFile("R", { stateDir });
  assert.ok(existsSync(file));
  const warm = await warmDoor({ root: "R", stateDir });
  await warm.door("boardroom_personas_sue_list", {});
  assert.ok(timers.cleared >= 1, "a request restarts the idle clock");
  assert.equal(exited, 0);
  await timers.fns.at(-1)();
  assert.equal(exited, 1);
  assert.equal(existsSync(file), false);
  assert.equal(w.closed, 1, "the held door is closed");
  assert.equal(await warmDoor({ root: "R", stateDir }), null, "nothing answers any more");
});

test("a second holder for the same root exits at once and leaves the first one's state file", async () => {
  const stateDir = fresh();
  const w1 = fakeOpen();
  const w2 = fakeOpen();
  const first = await startHolder({ root: "R", stateDir, openDoor: w1.openDoor });
  try {
    const before = readFileSync(holderStateFile("R", { stateDir }), "utf8");
    const second = await startHolder({ root: "R", stateDir, openDoor: w2.openDoor });
    assert.equal(second, null);
    assert.equal(w2.opened, 0, "no second door is opened");
    assert.equal(readFileSync(holderStateFile("R", { stateDir }), "utf8"), before);
    // Another root is its own holder.
    const other = await startHolder({ root: "R2", stateDir, openDoor: w2.openDoor });
    assert.ok(other);
    await other.close();
  } finally {
    await first.close();
  }
});

test("a state file naming a dead holder is no holder: warmDoor answers null, and a new holder replaces it", async () => {
  const stateDir = fresh();
  writeFileSync(holderStateFile("R", { stateDir }), JSON.stringify({ port: 1, token: "x", pid: 1 }));
  assert.equal(await warmDoor({ root: "R", stateDir }), null);
  const w = fakeOpen();
  const holder = await startHolder({ root: "R", stateDir, openDoor: w.openDoor });
  try {
    assert.ok(holder);
    assert.ok(await warmDoor({ root: "R", stateDir }));
  } finally {
    await holder.close();
  }
});

test("the holder answers a live HEAD for the builds it is asked about, through its own fetch", async () => {
  const stateDir = fresh();
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return { ok: true, status: 200, headers: { get: (h) => (h === "x-v" ? "b9" : null) } };
  };
  const holder = await startHolder({ root: "R", stateDir, openDoor: fakeOpen().openDoor, fetchFn });
  try {
    const warm = await warmDoor({ root: "R", stateDir });
    const got = await warm.builds([{ url: "https://one.test/", header: "x-v" }]);
    assert.deepEqual(got, { builds: { "https://one.test/": "b9" } });
    await warm.builds([{ url: "https://one.test/", header: "x-v" }]);
    assert.equal(seen.length, 2, "asked live each time, never remembered");
  } finally {
    await holder.close();
  }
});

test("ensureHolder starts one detached, hidden process only when none answers, and never throws", async () => {
  const root = fresh();
  const spawned = [];
  const spawnFn = (cmd, args, opts) => (spawned.push({ args, opts }), { unref() {} });
  assert.equal(await ensureHolder({ root, spawnFn, warm: async () => null }), true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.windowsHide, true);
  assert.deepEqual(spawned[0].args.slice(1), ["--root", root]);
  assert.equal(await ensureHolder({ root, spawnFn, warm: async () => ({}) }), false);
  assert.equal(spawned.length, 1, "a live holder is left alone");
  assert.equal(
    await ensureHolder({
      root,
      spawnFn: () => {
        throw new Error("no spawn");
      },
      warm: async () => null,
    }),
    false,
  );
});

const HEAD_OK = (v) => async (url, init) => ({ ok: true, status: 200, headers: { get: (h) => (h === "x-v" ? v : null) }, init, url });

test("/identity answers the builds, the list and the critics' minds in one call, each live call made once", async () => {
  const stateDir = fresh();
  const personas = [
    { doc: { id: "a" }, updatedAt: "t" },
    { doc: { id: "doc", critic: true }, updatedAt: "t" },
    { doc: { id: "late", critic: true }, updatedAt: "t" },
  ];
  const w = fakeOpen({ personas });
  const seen = [];
  const fetchFn = async (url, init) => (seen.push(`${init.method} ${url}`), HEAD_OK("b9")(url, init));
  const holder = await startHolder({ root: "R", stateDir, openDoor: w.openDoor, fetchFn, engineId: ({ checkout }) => `eng:${checkout}` });
  try {
    const warm = await warmDoor({ root: "R", stateDir });
    assert.equal(typeof warm.identity, "function");
    // "doc" was guessed critic (asked beside the list); "late" was not and is asked once the list shows her.
    const got = await warm.identity({
      builds: [{ url: "https://one.test/", header: "x-v" }],
      engine: { checkout: "C" },
      people: { ids: ["a", "doc", "late"], critics: ["doc"] },
    });
    assert.deepEqual(got.builds, { builds: { "https://one.test/": "b9" } });
    assert.equal(got.engine, "eng:C");
    assert.deepEqual(got.list, personas);
    assert.deepEqual(got.minds, { doc: "mind of doc", late: "mind of late" });
    assert.deepEqual(seen, ["HEAD https://one.test/"], "one live HEAD");
    const count = (tool) => w.calls.filter((c) => c.tool === tool);
    assert.equal(count("boardroom_personas_sue_list").length, 1, "one list");
    assert.deepEqual(
      count("boardroom_personas_sue_mind")
        .map((c) => c.body.sueId)
        .sort(),
      ["doc", "late"],
      "one mind each",
    );
    // A wrong guess (a persona that is no critic) is dropped, not returned.
    const again = await warm.identity({ people: { ids: ["a"], critics: ["a"] } });
    assert.deepEqual(again.minds, {});
    assert.equal(again.engine, null, "no engine asked for, none answered");
    assert.equal(again.builds, null);
  } finally {
    await holder.close();
  }
});

test("a kept connection is re-warmed at most once a minute, a live HEAD each time, and the idle clock is not touched", async () => {
  const stateDir = fresh();
  const timers = fakeTimers();
  let clock = 0;
  const seen = [];
  const fetchFn = async (url, init) => (seen.push(init.method), HEAD_OK("b9")(url, init));
  let exited = 0;
  const holder = await startHolder({
    root: "R",
    stateDir,
    openDoor: fakeOpen().openDoor,
    fetchFn,
    timers,
    now: () => clock,
    onExit: () => (exited += 1),
  });
  try {
    const warm = await warmDoor({ root: "R", stateDir });
    await warm.builds([{ url: "https://one.test/", header: "x-v" }]);
    assert.equal(seen.length, 1);
    const at = timers.ms.indexOf(60_000);
    assert.notEqual(at, -1, "a re-warm is scheduled a minute out");
    const rewarm = timers.fns[at];
    const cleared = timers.cleared;
    clock = 30_000;
    await rewarm();
    assert.equal(seen.length, 1, "the ask 30 s ago kept it warm: nothing sent");
    clock = 61_000;
    await rewarm();
    assert.equal(seen.length, 2, "a minute on: one HEAD");
    await rewarm();
    assert.equal(seen.length, 2, "never twice inside a minute");
    assert.equal(timers.cleared, cleared, "the idle clock was not reset");
    assert.equal(exited, 0);
  } finally {
    await holder.close();
  }
});

test("a holder whose own code changed on disk answers engine: null, and exits after answering", async () => {
  const stateDir = fresh();
  const code = path.join(fresh(), "engine-store.mjs");
  writeFileSync(code, "export const a = 1;");
  let exited = 0;
  const holder = await startHolder({
    root: "R",
    stateDir,
    openDoor: fakeOpen().openDoor,
    engineId: () => "eng",
    codeFiles: [code],
    onExit: () => (exited += 1),
  });
  try {
    const warm = await warmDoor({ root: "R", stateDir });
    assert.equal((await warm.identity({ engine: { checkout: "C" } })).engine, "eng", "untouched code answers");
    assert.equal(exited, 0);
    writeFileSync(code, "export const a = 22;");
    const got = await warm.identity({ engine: { checkout: "C" } });
    assert.equal(got.engine, null, "the client hashes for itself");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(exited, 1, "a stale holder lets go once it has answered");
  } finally {
    await holder.close();
  }
});

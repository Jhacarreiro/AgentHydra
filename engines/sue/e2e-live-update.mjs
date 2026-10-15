#!/usr/bin/env node
/**
 * e2e-live-update - proof on real processes that new code never reaches a running wave.
 * ================================================================================================
 *
 * Owner, 2026-09-25: "someone starts a Sue on 1.14, you push 1.15, all the Sues keep running on 1.14,
 * all new Sues start on 1.15, we never stop the current Sues." The specs prove each piece with stubs
 * (tests/engine-store, engine-lease, engine-route, manager-refresh); this runs the whole thing:
 *
 *   a. a fake checkout: a temp copy of the engine's closure (lib/engine-store.mjs computeClosure) with
 *      junctions to the real node_modules, and a tiny static site on a free port;
 *   b. a one-Sue chat-brain wave started through the fake checkout's CLI, pinned to snapshot A, and one
 *      look through the checkout's hand.mjs;
 *   c. a changed sentinel file (engine B) and a second wave, pinned to snapshot B;
 *   d. wave A untouched, and a second look at it through engine B's hand.mjs, sent by snapshot A;
 *   e. a Sue Manager from the fake checkout that moves itself onto the code once it changes again,
 *      while both waves keep running;
 *   f. a stop of wave A through the checkout's CLI, carried out by snapshot A, then a collection:
 *      snapshot A goes, the current code's stays, the real node_modules are untouched. When the
 *      machine's shared Sue browser (browser-host.mjs) was started from snapshot A, A is first shown
 *      kept for it, wave B (on the same browser) is stopped by its own snapshot, and A goes once the
 *      host has closed on its own; otherwise wave B's snapshot is shown kept for its live runner;
 *   g. everything it started killed (by a path inside its temp folder), the temp folder removed.
 *
 *   ~/.claude/tools/fairjob.cmd -Weight 3 -Run "node sue/e2e-live-update.mjs"
 *
 * MANUAL, and in no test lane: it launches headless Chrome and takes a few minutes (the Manager looks at
 * the code once a minute and moves on its second look). Everything lives in one temp folder: SUE_HOME,
 * SUE_ENGINE_STORE, TEMP, the workspace and the fake checkout. It kills only processes whose command line
 * names that folder, and nothing reaches AWS: the site's target has no mailbox and AWS_PROFILE names no
 * profile. Which code a process ran is read from a module-load hook (NODE_OPTIONS --import, written into
 * the temp folder) that logs every file each node process loads. It prints one JSON verdict
 * { ok, root, steps: [{ name, ok, evidence }] } and exits 1 when any step failed.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeClosure, leaseLive, processTable, removeTree } from "./lib/engine-store.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.resolve(HERE, "..");
const SUE = ["sue"];
const INTENT = "A neighbour posted this bakery's page in the street's group chat; you want to see what it sells.";

const low = (p) => path.resolve(p).toLowerCase();
const under = (file, dir) => low(file).startsWith(`${low(dir)}${path.sep}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tail = (text, n = 600) => String(text ?? "").slice(-n);

class Failed extends Error {
  constructor(message, evidence) {
    super(message);
    this.evidence = evidence;
  }
}
function check(ok, message, evidence = null) {
  if (!ok) throw new Failed(message, evidence);
}

async function until(probe, { timeoutMs, everyMs = 1000, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Failed(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// ── the temp world ──────────────────────────────────────────────────────────────────────────
// Made by `makeWorld` when the proof runs, never on import: this file sits in sue, so it is in
// every snapshot, and tests/engine-store.spec.mjs imports every module a snapshot carries (2026-09-25:
// a top-level proof ran a whole e2e inside that spec and left its waves running).

let root = null;
let at = null;
let baseEnv = null;
let traceEntry = null;
let sentinel = null;

const short = (p) => (under(p, root) ? path.relative(root, p) : p);
const inCheckout = (...parts) => path.join(at.checkout, ...SUE, ...parts);
const inEngine = (engine, ...parts) => path.join(engine.root, ...SUE, ...parts);
const statusFile = (runId) => path.join(at.home, "state", "mcp", `${runId}.status.json`);
const runLog = (runId) => path.join(at.home, "state", "mcp", `${runId}.log`);
const runDirOf = (runId) => path.join(at.home, "runs", runId);

function makeWorld() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sue-e2e-live-"));
  // Step g removes it on a clean run; this catches the runs where a failed step kept g from reaching it.
  process.on("exit", () => {
    if (!fs.existsSync(root)) return;
    try {
      removeTree(root, { within: path.dirname(root) });
    } catch (err) {
      process.stderr.write(`could not remove ${root}: ${err.message}\n`);
    }
  });
  at = {
    checkout: path.join(root, "checkout"),
    home: path.join(root, "home"),
    store: path.join(root, "store"),
    ws: path.join(root, "workspace"),
    tmp: path.join(root, "tmp"),
  };
  for (const dir of Object.values(at)) fs.mkdirSync(dir, { recursive: true });
  sentinel = inCheckout("e2e-sentinel.txt");

  // The engine reads SUE_HOME when it is called, so the fake checkout's modules this process imports
  // (the target it pre-writes, the collection in step f) land in the temp world too.
  process.env.SUE_HOME = at.home;
  process.env.SUE_ENGINE_STORE = at.store;
  baseEnv = {
    ...process.env,
    SUE_HOME: at.home,
    SUE_ENGINE_STORE: at.store,
    TEMP: at.tmp,
    TMP: at.tmp,
    AWS_PROFILE: "sue-e2e-no-aws",
  };
  for (const name of [
    "SUE_ENGINE_ROUTED",
    "SUE_BRAIN",
    "SUE_MANAGER_SUPERVISED",
    "NODE_OPTIONS",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ])
    delete baseEnv[name];

  // The module-load log: every node process started with `traced(name)` (and everything it starts, which
  // inherits NODE_OPTIONS) appends "<pid> <file url>" for each file it loads to loads-<name>.log.
  const traceHooks = path.join(root, "trace-hooks.mjs");
  traceEntry = path.join(root, "trace-loads.mjs");
  fs.writeFileSync(
    traceHooks,
    [
      'import fs from "node:fs";',
      "let log = null;",
      "export function initialize(data) { log = data?.log ?? null; }",
      "export async function load(url, context, nextLoad) {",
      '  if (log && url.startsWith("file:")) try { fs.appendFileSync(log, `${process.pid} ${url}\\n`); } catch {}',
      "  return nextLoad(url, context);",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    traceEntry,
    [
      'import { register } from "node:module";',
      `if (process.env.SUE_E2E_LOADS) register(${JSON.stringify(pathToFileURL(traceHooks).href)}, { data: { log: process.env.SUE_E2E_LOADS } });`,
      "",
    ].join("\n"),
  );
}

const loadsLog = (name) => path.join(root, `loads-${name}.log`);
const traced = (name) => ({ ...baseEnv, NODE_OPTIONS: `--import=${pathToFileURL(traceEntry).href}`, SUE_E2E_LOADS: loadsLog(name) });
function loadsOf(name) {
  return readText(loadsLog(name))
    .split(/\r?\n/)
    .map((line) => /^(\d+) (file:\S+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), file: fileURLToPath(m[2]) }));
}

function argsFile(name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** A node process of the engine's, windowless, its output collected; resolves when it exits. */
function run(argv, { env = baseEnv, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: at.ws, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, code: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, code, stdout, stderr });
    });
  });
}

const jsonOf = (res) => {
  try {
    return JSON.parse(res.stdout.trim());
  } catch {
    return null;
  }
};

function powershell(command, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 << 20, encoding: "utf8" },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout)),
    );
  });
}

/** Every process on the machine: pid, parent, Windows' creation time (epoch ms) and command line. */
async function processList() {
  const out = await powershell(
    "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, " +
      "$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }), ($_.CommandLine -replace '\\s+', ' ') }",
  );
  return String(out)
    .split(/\r?\n/)
    .map((line) => line.split("|"))
    .filter((parts) => parts.length >= 4 && /^\d+$/.test(parts[0]))
    .map(([pid, parent, created, ...cmd]) => ({
      pid: Number(pid),
      parent: Number(parent),
      createdAt: Number(created),
      commandLine: cmd.join("|"),
    }));
}

const sameProcess = (procs, { pid, createdAt }) => procs.some((p) => p.pid === pid && p.createdAt === createdAt);

async function portOwner(port) {
  const out = await powershell(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
  );
  const pid = Number(String(out).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function killTree(pid) {
  return new Promise((resolve) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The page the Sues are sent to: two plain pages on loopback, so every Sue browser runs headless. */
function startSite() {
  const pages = {
    "/": "<!doctype html><title>Rosa's Bakery</title><h1>Rosa's Bakery</h1><p>Fresh bread every morning: sourdough, rye and cinnamon rolls.</p><a href='/menu'>See the menu</a> <button>Order for pickup</button>",
    "/menu":
      "<!doctype html><title>Menu - Rosa's Bakery</title><h1>Menu</h1><ul><li>Sourdough loaf, $6</li><li>Rye, $5</li><li>Cinnamon roll, $3</li></ul><a href='/'>Back</a>",
  };
  const server = http.createServer((req, res) => {
    const page = pages[new URL(req.url, "http://site").pathname];
    res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(page ?? "<!doctype html><h1>Not found</h1>");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })),
  );
}

/** What a collection must never reach: the real node_modules behind every junction, by entry count and two packages' stamps. */
function nodeModulesState() {
  const dir = path.join(REAL, "node_modules");
  const probe = (name) => {
    try {
      const st = fs.statSync(path.join(dir, name, "package.json"));
      return `${name} ${st.size} ${st.mtimeMs}`;
    } catch {
      return `${name} missing`;
    }
  };
  return JSON.stringify({ entries: fs.readdirSync(dir).length, packages: [probe("playwright-core"), probe("sharp")] });
}

// ── waves and moves ─────────────────────────────────────────────────────────────────────────

/** One Sue, a chat brain, no account, no window: the smallest real wave. */
async function startWave(label) {
  const runArgs = { url: site.url, intent: INTENT, count: 1, brain: "chat", createAccounts: false, contactSupport: false };
  const res = await run([inCheckout("sue.mjs"), "run", "--workspace", at.ws, "--json-file", argsFile(`run-${label}`, runArgs)], {
    env: traced(`wave${label}`),
    timeoutMs: 180_000,
  });
  const answer = jsonOf(res);
  check(answer?.ok === true && answer.runId, `wave ${label} did not start`, {
    code: res.code,
    stdout: tail(res.stdout),
    stderr: tail(res.stderr),
  });
  const { runId } = answer;
  const status = readJson(statusFile(runId));
  check(status?.state === "running" && status.pid && status.engine?.id, `wave ${label}'s runner wrote no running status`, status);
  const { engine, pid } = status;
  const proc = (await processList()).find((p) => p.pid === pid);
  check(proc, `wave ${label}'s runner (pid ${pid}) is not running`);
  const runnerScript = inEngine(engine, "sue.mjs");
  check(
    under(engine.root, at.store) && low(proc.commandLine).includes(low(runnerScript)) && proc.commandLine.includes("_runner"),
    `wave ${label}'s runner is not its snapshot's sue.mjs`,
    { commandLine: proc.commandLine, engine },
  );
  const leaseFile = path.join(engine.root, ".leases", `${pid}.json`);
  const lease = readJson(leaseFile);
  check(lease?.role === "runner" && lease.runId === runId, `wave ${label}'s runner holds no lease on its snapshot`, { leaseFile, lease });
  const live = leaseLive({ pid, startedAtMs: lease.startedAtMs }, await processTable([pid]));
  check(live, `wave ${label}'s lease does not read as live (its start is not the OS's)`, { lease, osCreatedAt: proc.createdAt });
  const staged = /\[sue\] engine (\w+): (.+?) in (\d+) ms/.exec(readText(runLog(runId)));
  const sueId = await until(() => readJson(path.join(runDirOf(runId), "chat-brains.json"))?.sues?.[0]?.sueId, {
    timeoutMs: 60_000,
    what: `wave ${label}'s Sue to be listed`,
  });
  return {
    runId,
    pid,
    createdAt: proc.createdAt,
    commandLine: proc.commandLine,
    engine,
    sueId,
    lease: { file: short(leaseFile), startedAtMs: lease.startedAtMs, osCreatedAt: proc.createdAt },
    staged: staged ? { id: staged[1], how: staged[2], ms: Number(staged[3]) } : null,
  };
}

const traceRows = (sueDir) => readText(path.join(sueDir, "trace.jsonl")).split(/\r?\n/).filter(Boolean).length;
function lookShots(sueDir) {
  try {
    return fs.readdirSync(path.join(sueDir, "shots")).filter((name) => /^look-.*\.jpg$/.test(name));
  } catch {
    return [];
  }
}

/** One look through the fake checkout's hand.mjs, and which copy of lib/hand-move.mjs sent it. */
async function look(wave, name) {
  const sueDir = path.join(runDirOf(wave.runId), wave.sueId);
  const rowsBefore = traceRows(sueDir);
  const shotsBefore = lookShots(sueDir);
  const res = await run([inCheckout("hand.mjs"), wave.runId, wave.sueId, "look"], { env: traced(name), timeoutMs: 180_000 });
  check(res.code === 0, `the look did not reach ${wave.sueId}`, { code: res.code, stdout: tail(res.stdout), stderr: tail(res.stderr) });
  const after = await until(
    () => {
      const rows = traceRows(sueDir);
      const shots = lookShots(sueDir);
      return rows > rowsBefore && shots.length > shotsBefore.length ? { rows, shots } : null;
    },
    { timeoutMs: 20_000, everyMs: 500, what: "a trace row and a look picture" },
  );
  const loaded = loadsOf(name).filter((l) => l.pid === res.pid);
  const theirs = inEngine(wave.engine, "lib", "hand-move.mjs");
  const ours = inCheckout("lib", "hand-move.mjs");
  return {
    handPid: res.pid,
    said: res.stdout.trim().split(/\r?\n/)[0].slice(0, 160),
    traceRows: `${rowsBefore} -> ${after.rows}`,
    newShots: after.shots.filter((s) => !shotsBefore.includes(s)),
    checkoutHandMoveLoaded: loaded.some((l) => low(l.file) === low(ours)),
    sentBy: loaded.some((l) => low(l.file) === low(theirs)) ? short(theirs) : null,
  };
}

// ── the proof ───────────────────────────────────────────────────────────────────────────────

const steps = [];
let site = null;
let closure = null;
let nodeModulesBefore = null;
let waveA = null;
let waveB = null;

async function step(name, fn) {
  const began = Date.now();
  try {
    const evidence = await fn();
    steps.push({ name, ok: true, evidence: { ...evidence, ms: Date.now() - began } });
    return true;
  } catch (err) {
    steps.push({
      name,
      ok: false,
      evidence: { error: err.message, ...(err.evidence ? { detail: err.evidence } : {}), ms: Date.now() - began },
    });
    if (!(err instanceof Failed))
      steps.at(-1).evidence.stack = String(err.stack ?? "")
        .split("\n")
        .slice(0, 6)
        .join("\n");
    return false;
  }
}
const skip = (name, why) => steps.push({ name, ok: false, evidence: { skipped: why } });

async function prove() {
  const a = await step("a. fake checkout and site", async () => {
    nodeModulesBefore = nodeModulesState();
    closure = computeClosure({ checkout: REAL });
    check(!closure.unresolved.length && !closure.unpinned.length, "the real engine imports something a snapshot cannot carry", {
      unresolved: closure.unresolved,
      unpinned: closure.unpinned,
    });
    for (const rel of closure.files) {
      const to = path.join(at.checkout, ...rel.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, closure.contents.get(rel));
    }
    for (const rel of closure.junctions) {
      const link = path.join(at.checkout, ...rel.split("/"));
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(REAL, ...rel.split("/")), link, "junction");
    }
    fs.writeFileSync(sentinel, "engine A\n");
    site = await startSite();
    // The page's own target, written before any wave: no mailbox, so no mailroom and no AWS.
    const { deriveTarget } = await import(pathToFileURL(inCheckout("lib", "workspace.mjs")).href);
    const { file, target } = deriveTarget({ ws: at.ws, url: site.url });
    fs.writeFileSync(file, `${JSON.stringify({ ...target, mailbox: { kind: "none" } }, null, 2)}\n`);
    const fake = computeClosure({ checkout: at.checkout });
    check(
      fake.files.length === closure.files.length + 1 && !fake.unresolved.length,
      "the fake checkout is not the real closure plus the sentinel",
      { real: closure.files.length, fake: fake.files.length, unresolved: fake.unresolved },
    );
    return {
      root,
      files: closure.files.length,
      outOfTree: closure.outOfTree.length,
      junctions: closure.junctions,
      realId: closure.id,
      fakeId: fake.id,
      site: site.url,
      target: short(file),
    };
  });
  if (!a) return;

  const b = await step("b. wave A pinned to snapshot A, one look", async () => {
    waveA = await startWave("A");
    const moved = await look(waveA, "moveA1");
    check(moved.sentBy, "the look was not sent by snapshot A's lib/hand-move.mjs", moved);
    return { ...waveA, commandLine: undefined, runner: waveA.commandLine.slice(0, 240), move: moved };
  });
  if (!b) return;

  const c = await step("c. engine B: a changed sentinel, wave B on a new snapshot", async () => {
    fs.writeFileSync(sentinel, "engine B\n");
    waveB = await startWave("B");
    check(waveB.engine.id !== waveA.engine.id && low(waveB.engine.root) !== low(waveA.engine.root), "wave B runs on wave A's snapshot", {
      a: waveA.engine,
      b: waveB.engine,
    });
    check(readText(inEngine(waveB.engine, "e2e-sentinel.txt")) === "engine B\n", "snapshot B does not carry engine B's sentinel");
    return {
      runId: waveB.runId,
      pid: waveB.pid,
      engineA: waveA.engine.id,
      engineB: waveB.engine.id,
      staged: waveB.staged,
      lease: waveB.lease,
    };
  });
  if (!c) return;

  const d = await step("d. wave A untouched; engine B's hand.mjs moves it through snapshot A", async () => {
    const procs = await processList();
    const runner = procs.find((p) => p.pid === waveA.pid);
    check(runner && runner.createdAt === waveA.createdAt && runner.commandLine === waveA.commandLine, "wave A's runner changed", {
      before: { pid: waveA.pid, createdAt: waveA.createdAt },
      now: runner ?? null,
    });
    const status = readJson(statusFile(waveA.runId));
    check(status?.state === "running" && status.engine?.id === waveA.engine.id, "wave A's record moved off snapshot A", status);
    check(readText(inEngine(waveA.engine, "e2e-sentinel.txt")) === "engine A\n", "snapshot A's code changed under it");
    check(readJson(path.join(waveA.engine.root, ".sue-engine.json"))?.id === waveA.engine.id, "snapshot A's manifest is gone");
    const moved = await look(waveA, "moveA2");
    check(moved.checkoutHandMoveLoaded && moved.sentBy, "the look through engine B's CLI was not sent by snapshot A", moved);
    return { runner: { pid: runner.pid, createdAt: runner.createdAt }, snapshot: waveA.engine.id, move: moved };
  });
  if (!d) return;

  await step("d2. every process of wave A loaded only snapshot A's code", async () => {
    const lines = loadsOf("waveA");
    const pids = new Set(lines.filter((l) => under(l.file, waveA.engine.root)).map((l) => l.pid));
    check(pids.has(waveA.pid), "the runner's module loads were not logged", { pids: [...pids] });
    const cannon = inEngine(waveA.engine, "cannon.mjs");
    const body = inEngine(waveA.engine, "body.mjs");
    const cannonPids = [...new Set(lines.filter((l) => low(l.file) === low(cannon)).map((l) => l.pid))];
    check(cannonPids.length, "no process loaded snapshot A's cannon.mjs");
    const nodeModules = `${path.sep}node_modules${path.sep}`;
    const strays = lines.filter(
      (l) =>
        pids.has(l.pid) &&
        !under(l.file, waveA.engine.root) &&
        (under(l.file, at.checkout) || under(l.file, at.store) || (under(l.file, REAL) && !low(l.file).includes(nodeModules))),
    );
    check(!strays.length, "a process of wave A loaded code from outside its snapshot", strays.slice(0, 10));
    // What each process is: the first file it loaded from the snapshot is its entry script.
    const roles = {};
    for (const l of lines) if (pids.has(l.pid) && !roles[l.pid] && under(l.file, waveA.engine.root)) roles[l.pid] = short(l.file);
    return {
      processes: roles,
      runner: waveA.pid,
      cannon: cannonPids,
      modulesFromSnapshot: lines.filter((l) => pids.has(l.pid) && under(l.file, waveA.engine.root)).length,
      bodyFromSnapshot: lines.some((l) => low(l.file) === low(body)),
    };
  });

  await step("e. the Manager moves onto new code while both waves run", async () => {
    const port = await freePort();
    const log = fs.openSync(path.join(root, "manager-first.log"), "a");
    let first;
    try {
      first = spawn(process.execPath, [inCheckout("manager.mjs"), "--port", String(port), "--no-open", "--no-tray"], {
        cwd: at.ws,
        env: baseEnv,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      });
      first.unref();
    } finally {
      fs.closeSync(log);
    }
    const oldPid = await until(() => portOwner(port), { timeoutMs: 60_000, what: "the first Manager to listen" });
    check(oldPid === first.pid, "something else holds the Manager's port", { port, owner: oldPid, started: first.pid });
    const oldProc = (await processList()).find((p) => p.pid === oldPid);
    check(oldProc, "the first Manager is not in the process list", { oldPid });
    fs.writeFileSync(sentinel, "engine C\n");
    const changedAt = Date.now();
    const newPid = await until(
      async () => {
        const owner = await portOwner(port);
        return owner && owner !== oldPid ? owner : null;
      },
      { timeoutMs: 240_000, everyMs: 2000, what: "a new Manager on the port" },
    );
    const tookMs = Date.now() - changedAt;
    await until(async () => !sameProcess(await processList(), oldProc), { timeoutMs: 20_000, what: "the old Manager to exit" });
    const procs = await processList();
    const successor = procs.find((p) => p.pid === newPid);
    check(
      successor && low(successor.commandLine).includes(low(inCheckout("manager.mjs"))),
      "the new Manager is not the checkout's manager.mjs",
      successor,
    );
    const managerJson = readJson(path.join(at.home, "state", "manager", "manager.json"));
    check(managerJson?.pid === newPid && managerJson.port === port, "manager.json does not name the new Manager", managerJson);
    check(sameProcess(procs, waveA) && sameProcess(procs, waveB), "a wave's runner did not survive the Manager's refresh", {
      waveA: sameProcess(procs, waveA),
      waveB: sameProcess(procs, waveB),
    });
    const said = readText(path.join(root, "manager-first.log"))
      .split(/\r?\n/)
      .filter((line) => /handing the port|keeps serving/.test(line));
    return { port, oldPid, newPid, tookMs, managerJson, firstManagerSaid: said, runnersKept: [waveA.pid, waveB.pid] };
  });

  await step("f. a routed stop of wave A, then a collection", async () => {
    const res = await run(
      [inCheckout("sue.mjs"), "stop", "--workspace", at.ws, "--json-file", argsFile("stop-A", { runId: waveA.runId })],
      { env: traced("stopA"), timeoutMs: 120_000 },
    );
    const answer = jsonOf(res);
    check(answer?.ok === true && answer.stopped === true, "the stop did not stop wave A", {
      code: res.code,
      stdout: tail(res.stdout),
      stderr: tail(res.stderr),
    });
    const aSue = inEngine(waveA.engine, "sue.mjs");
    const routedPids = [
      ...new Set(
        loadsOf("stopA")
          .filter((l) => l.pid !== res.pid && low(l.file) === low(aSue))
          .map((l) => l.pid),
      ),
    ];
    check(routedPids.length, "the stop was not carried out by snapshot A's sue.mjs", { cliPid: res.pid });
    await until(async () => !sameProcess(await processList(), waveA), { timeoutMs: 60_000, what: "wave A's runner to exit" });
    const onA = (procs) => procs.filter((p) => low(p.commandLine).includes(low(waveA.engine.root)));
    // The machine's one shared Sue browser (lib/shared-browser.mjs) is owned by a host that belongs to no
    // run's tree, started from the snapshot of whichever wave first needed a browser. It outlives the
    // stop on purpose and closes once no run has used it for its idle time; until then it leases A.
    const isHost = (p) => /browser-host\.mjs/.test(p.commandLine);
    const waveLeft = await until(
      async () => {
        const left = onA(await processList()).filter((p) => !isHost(p));
        return left.length ? null : true;
      },
      { timeoutMs: 60_000, what: "every process of wave A's own tree to exit" },
    ).catch(async (err) => {
      err.evidence = onA(await processList()).map((p) => ({ pid: p.pid, parent: p.parent, commandLine: p.commandLine.slice(0, 200) }));
      throw err;
    });
    const stoppedState = readJson(statusFile(waveA.runId))?.state;
    // The checkout's current code, staged, so the collection has a current snapshot to keep.
    const staged = jsonOf(await run([inCheckout("lib", "engine-store.mjs"), "stage", "--store", at.store]));
    check(staged?.id, "the checkout's current code did not stage");
    const store = await import(pathToFileURL(inCheckout("lib", "engine-store.mjs")).href);
    const current = store.currentEngineId({ checkout: at.checkout });
    check(current === staged.id, "the staged snapshot is not the checkout's current code", { current, staged: staged.id });
    // The ten-minute grace, shortened: each collection is told it is eleven minutes from now.
    const collect = () => store.collectGarbage({ root: at.store, keep: [current], now: Date.now() + store.YOUNG_MS + 60_000 });
    const host = onA(await processList()).find(isHost) ?? null;
    let whileHost = null;
    if (host) {
      const first = await collect();
      const a = first.kept.find((r) => r.id === waveA.engine.id);
      const b = first.kept.find((r) => r.id === waveB.engine.id);
      check(
        a && /browser-host/.test(a.reason) && fs.existsSync(waveA.engine.root),
        "snapshot A was not kept for the live browser host",
        first,
      );
      check(b && /live lease/.test(b.reason), "wave B's snapshot was not kept for its live runner", first);
      // Wave B joined the same browser when it started, so the host closes only once B is done too:
      // B is stopped the same way, by its own snapshot, and the host is left to close on its own.
      const res = await run(
        [inCheckout("sue.mjs"), "stop", "--workspace", at.ws, "--json-file", argsFile("stop-B", { runId: waveB.runId })],
        { env: traced("stopB"), timeoutMs: 120_000 },
      );
      const stopB = jsonOf(res);
      const bSue = inEngine(waveB.engine, "sue.mjs");
      const routedB = loadsOf("stopB").some((l) => l.pid !== res.pid && low(l.file) === low(bSue));
      check(stopB?.stopped === true && routedB, "wave B was not stopped by its own snapshot", { stopB, routedB });
      waveB.stopped = true;
      const since = Date.now();
      await until(async () => !onA(await processList()).length, {
        timeoutMs: 240_000,
        everyMs: 3000,
        what: "the shared browser host to close",
      });
      whileHost = {
        host: host.pid,
        a: a.reason,
        b: b.reason,
        stopB: { stopped: stopB.stopped, routed: routedB },
        hostClosedAfterMs: Date.now() - since,
      };
    }
    const gc = await collect();
    const verdict = (id) => [...gc.removed, ...gc.kept, ...gc.skipped].find((r) => r.id === id) ?? null;
    check(gc.removed.some((r) => r.id === waveA.engine.id) && !fs.existsSync(waveA.engine.root), "snapshot A was not removed", gc);
    if (!waveB.stopped)
      check(
        gc.kept.some((r) => r.id === waveB.engine.id) && readJson(path.join(waveB.engine.root, ".sue-engine.json")),
        "wave B's snapshot was not kept",
        gc,
      );
    check(gc.kept.some((r) => r.id === current) && fs.existsSync(path.join(at.store, current)), "the current snapshot was not kept", gc);
    check(nodeModulesState() === nodeModulesBefore, "the real node_modules changed", {
      before: nodeModulesBefore,
      after: nodeModulesState(),
    });
    check(
      fs.readdirSync(path.join(at.checkout, "node_modules")).length > 0,
      "the fake checkout's node_modules junction no longer resolves",
    );
    return {
      answer: { ok: answer.ok, stopped: answer.stopped },
      cliPid: res.pid,
      routedTo: { pids: routedPids, script: short(aSue) },
      stateAfter: stoppedState,
      waveTreeGone: waveLeft,
      current,
      whileBrowserHostLived: whileHost,
      gc: { a: verdict(waveA.engine.id), b: verdict(waveB.engine.id), current: verdict(current) },
      nodeModules: JSON.parse(nodeModulesState()),
    };
  });
}

async function cleanUp() {
  await step("g. clean up", async () => {
    let stopB = null;
    if (waveB && !waveB.stopped) {
      const res = await run(
        [inCheckout("sue.mjs"), "stop", "--workspace", at.ws, "--json-file", argsFile("stop-B", { runId: waveB.runId })],
        { timeoutMs: 120_000 },
      );
      stopB = jsonOf(res) ?? { code: res.code, stdout: tail(res.stdout, 200) };
    }
    // Everything this proof started names the temp folder on its command line (its scripts, SUE_HOME,
    // TEMP for Chrome's profile), and nothing else on this machine does.
    const mine = () => processList().then((procs) => procs.filter((p) => p.pid !== process.pid && low(p.commandLine).includes(low(root))));
    const killed = [];
    for (let round = 0; round < 5; round += 1) {
      const left = await mine();
      if (!left.length) break;
      for (const p of left) {
        killed.push(p.pid);
        await killTree(p.pid);
      }
      await sleep(1000);
    }
    const left = await mine();
    check(
      !left.length,
      "processes of this proof are still running",
      left.map((p) => ({ pid: p.pid, commandLine: p.commandLine.slice(0, 200) })),
    );
    site?.server.closeAllConnections();
    await new Promise((resolve) => (site ? site.server.close(() => resolve()) : resolve()));
    // The junctions first, by themselves: removeTree never follows one, and this makes sure of it.
    for (const rel of closure?.junctions ?? []) {
      const link = path.join(at.checkout, ...rel.split("/"));
      if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
      try {
        fs.unlinkSync(link);
      } catch {
        fs.rmdirSync(link);
      }
    }
    let removed = false;
    for (let attempt = 0; attempt < 10 && !removed; attempt += 1) {
      try {
        removeTree(root, { within: path.dirname(root) });
        removed = !fs.existsSync(root);
      } catch (err) {
        if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(err.code) || attempt === 9) throw err;
        await sleep(1000);
      }
    }
    check(removed, "the temp folder is still there", { root });
    if (nodeModulesBefore)
      check(nodeModulesState() === nodeModulesBefore, "the real node_modules changed", {
        before: nodeModulesBefore,
        after: nodeModulesState(),
      });
    return { stopB, killed: [...new Set(killed)], removed: root };
  });
}

async function main() {
  makeWorld();
  try {
    await prove();
  } catch (err) {
    steps.push({ name: "unexpected", ok: false, evidence: { error: String(err?.stack ?? err) } });
  } finally {
    const planned = ["a.", "b.", "c.", "d.", "d2.", "e.", "f."];
    for (const prefix of planned)
      if (!steps.some((s) => s.name.startsWith(prefix))) skip(`${prefix} (not reached)`, "an earlier step failed");
    await cleanUp();
  }
  const ok = steps.every((s) => s.ok);
  process.stdout.write(`${JSON.stringify({ ok, root, steps }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

if (isMainModule(import.meta.main, import.meta.url)) await main();

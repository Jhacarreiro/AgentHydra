/**
 * run-dir - where a SUE run lives on disk, and the two pieces of state that outlive every run.
 * ============================================================================================
 *
 * WHAT: the one module that knows the layout `sue/SPEC.md` draws: `runs/<runId>/` (one
 * manifest, one dir per Sue, `mail/`, the report) and `state/` (`counter.json`, the global Sue
 * number that starts at 1117 because the owner's own example was "Grandma Sue 1117", and
 * `accounts-ledger.jsonl`, every account a Sue ever made). Both roots are gitignored.
 *
 * WHY IT EXISTS: the cannon, the body, the mailroom, the report and the reaper all need to agree
 * on the same paths, and the account ledger is the record of every real account a Sue made (the
 * reaper closes rows from it). A second spelling of any of these paths is how a Sue's mail ends up
 * in a directory nobody polls.
 *
 * WHO DEPENDS ON IT: `cannon.mjs` (run + Sue dirs, manifest, counter, ledger), `body.mjs` (reads
 * the Sue dir it was handed), `mailroom.mjs` (manifest for the address list), `report.mjs`,
 * `reap.mjs` (ledger rows with `deletedAt: null`).
 *
 * `SUE_HOME` in the environment relocates BOTH roots (tests point it at a temp dir so a dry run
 * never consumes a real Sue number or writes a real ledger row).
 */
import { loadTarget, targetPath } from "../../lib/target.mjs";
import fs from "node:fs";
import path from "node:path";

import { renameSyncRetrying } from "../../lib/shared/rename-retrying.mjs";
import { checkoutRoot } from "./engine-lease.mjs";

// The checkout's sue, also for a wave running from a snapshot of this code (lib/engine-store.mjs):
// its runs and state live where every other engine reads them, never beside a copy the store deletes.
const SUE_ROOT = targetPath(loadTarget().sueStore);

export const FIRST_SUE_NUMBER = 1117;
// ⛔ NO PER-MACHINE DAILY ACCOUNT CAP (Owner, 2026-09-23, after asking twice: 2026-09-22 "wtf does sue
// have a limit", then "why is this still here" when an ACCAP chat reported a wave "blocked until 7am"
// off this file's old 200 while the server had room for hundreds more). It was a second copy of the
// server's Sue-door cap that could only ever disagree with it: it counted this machine's ledger
// alone, in accounts, and it was the one that actually blocked runs. The server's cap went the same
// day (turnstile-gate.ts: "Sue is a feature we sell to people ... it just costs them Connections
// account tokens"), so there is no daily Sue ceiling anywhere; a door refusal (wrong key) still stops
// the run by name (sueDoorRefusedFrom in cannon.mjs). `--max-accounts` per run is unchanged.

function home() {
  return process.env.SUE_HOME ? path.resolve(process.env.SUE_HOME) : SUE_ROOT;
}

export function runsRoot() {
  return path.join(home(), "runs");
}

export function stateRoot() {
  return path.join(home(), "state");
}

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** `YYYYMMDD-HHMMSS-xxxx`: sortable, unique enough for one box, and a legal email local part. */
export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/** A new id of the {@link RUN_ID_PATTERN} shape. */
export function newRunId(now = new Date()) {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const salt = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${stamp}-${salt}`;
}

export function runDir(runId) {
  return path.join(runsRoot(), runId);
}

export function sueDir(runId, sueId) {
  return path.join(runDir(runId), sueId);
}

export function mailDir(runId) {
  return path.join(runDir(runId), "mail");
}

function counterFile() {
  return path.join(stateRoot(), "counter.json");
}

/** The counter file as written, every key kept (so a field a newer Sue added survives the next number), or {}. */
function readCounterFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(counterFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // first run, or a torn write
  }
}

/** The next number: the file's, or the owner's number when there is none or it is damaged. */
function readCounter(saved = readCounterFile()) {
  return Number.isInteger(saved.next) && saved.next >= FIRST_SUE_NUMBER ? saved.next : FIRST_SUE_NUMBER;
}

/** The number the next `nextSueNumber()` call WOULD hand out, without consuming it (dry runs). */
export function peekSueNumber() {
  return readCounter();
}

// Several cannons may start in the same second (one per persona, MonkeyWerx SimReddit, 2026-09-22).
// Unlocked, two of them read the same `next` and hand out the same number, and on Windows the second
// rename over a counter the first still holds throws EPERM, which killed one of eight runs at launch.
// So the read-and-advance holds an exclusive lock file; a lock older than LOCK_STALE_MS belongs to a
// process that died holding it and is broken, never waited on forever.
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 10_000;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function takeLock(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return fs.openSync(lock, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        /* released between the open and the stat: try again */
      }
      if (Date.now() > deadline) throw new Error(`${lock} held for over ${LOCK_WAIT_MS} ms`, { cause: err });
      pause(20 + Math.floor(Math.random() * 30));
    }
  }
}

/** Runs `fn` holding `<file>.lock`, the same exclusive lock the Sue counter takes: a read-modify-write of a file
 *  several processes write (a series' rounds, the counter) loses no one's write. Returns what `fn` returns. */
export function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const fd = takeLock(lock);
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/** Hands out the next global Sue number and advances the counter on disk in the same call. Safe across
 * processes started together: each caller gets a different number. */
export function nextSueNumber() {
  return withFileLock(counterFile(), () => {
    const saved = readCounterFile();
    const n = readCounter(saved);
    const tmp = `${counterFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...saved, next: n + 1, updatedAt: new Date().toISOString() }) + "\n");
    renameSyncRetrying(tmp, counterFile());
    return n;
  });
}

function ledgerFile() {
  return path.join(stateRoot(), "accounts-ledger.jsonl");
}

/** `{ address, sueId, runId, createdAt, deletedAt: null }` - one line per account ever made. */
export function appendAccountLedger(row) {
  if (!row || typeof row.address !== "string" || !row.address.includes("@")) {
    throw new Error("appendAccountLedger: a row needs an address");
  }
  fs.mkdirSync(stateRoot(), { recursive: true });
  const line = {
    address: row.address,
    sueId: row.sueId ?? null,
    runId: row.runId ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    deletedAt: row.deletedAt ?? null,
  };
  fs.appendFileSync(ledgerFile(), JSON.stringify(line) + "\n");
  return line;
}

/** Closes one account by APPENDING `{ closes: { address, sueId, runId }, deletedAt }`, never by rewriting
 * the file: a `--forever` cannon appends to this ledger while a reap runs, and a read-then-rewrite
 * would drop whatever it appended in between. `readAccountLedger` folds the closure onto its row. */
export function appendLedgerClosure({ address, sueId, runId, deletedAt }) {
  fs.mkdirSync(stateRoot(), { recursive: true });
  const line = { closes: { address, sueId: sueId ?? null, runId: runId ?? null }, deletedAt };
  fs.appendFileSync(ledgerFile(), JSON.stringify(line) + "\n");
  return line;
}

function sameAccount(row, key) {
  return row.address === key.address && (row.sueId ?? null) === (key.sueId ?? null) && (row.runId ?? null) === (key.runId ?? null);
}

/** Every account row, with each closure line folded onto the first still-open row it names. */
export function readAccountLedger() {
  let raw;
  try {
    raw = fs.readFileSync(ledgerFile(), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; /* a torn line is skipped, never fatal: the cap must still be computable */
    }
    if (parsed && parsed.closes) {
      const open = rows.find((row) => !row.deletedAt && sameAccount(row, parsed.closes));
      if (open) open.deletedAt = parsed.deletedAt;
      continue;
    }
    rows.push(parsed);
  }
  return rows;
}

/** Accounts created in the ROLLING last 24 hours - reported in a dry run's plan, never a gate. */
export function accountsToday(now = () => Date.now()) {
  const since = now() - 24 * 60 * 60 * 1000;
  return readAccountLedger().filter((r) => Date.parse(r.createdAt) >= since).length;
}

function manifestFile(runId) {
  return path.join(runDir(runId), "manifest.json");
}

export function readManifest(runId) {
  return JSON.parse(fs.readFileSync(manifestFile(runId), "utf8"));
}

export function writeManifest(runId, manifest) {
  fs.mkdirSync(runDir(runId), { recursive: true });
  const tmp = `${manifestFile(runId)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(tmp, manifestFile(runId));
  return manifestFile(runId);
}

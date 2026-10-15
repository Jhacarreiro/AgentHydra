// The SUE hunt: SUE's own ranked self-improvement queue (lib/sue-hunt.mjs). rankSueHunt is pure; gatherSueHunt reads a
// fixture workspace built in a temp folder (rounds jsonl, run folders, reuse.json), never a real round.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { decisionCommitsAsync, gatherSueHunt, rankSueHunt, renderSueHunt } from "../lib/sue-hunt.mjs";
import { seriesKey, writeRound } from "../lib/rounds.mjs";

const kinds = (items) => items.map((i) => i.kind);
const first = (items, kind) => items.find((i) => i.kind === kind);

test("an empty signal set ranks to nothing", () => {
  assert.deepEqual(rankSueHunt({}), []);
});

test("no-start: a run that did not start or ended as a brain error is an item naming the round and the file to fix", () => {
  const items = rankSueHunt({ noStart: [{ round: 8, subject: "round 8", why: "2 of 8 runs never started" }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "no-start");
  assert.match(items[0].evidence, /2 of 8 runs never started/);
  assert.match(items[0].action, /sue\//);
});

test("sue-side: a finding triaged into the sue-side bucket names its run and sue", () => {
  const items = rankSueHunt({ sueSide: [{ runId: "r1", sue: "sue-1-kid", finding: "sue-1-kid:4", why: "her browser was closed" }] });
  assert.equal(items[0].kind, "sue-side");
  assert.match(items[0].subject, /r1/);
  assert.match(items[0].evidence, /her browser was closed/);
});

test("mid-motion: a look taken while an animation still ran is an item, counted per Sue", () => {
  const items = rankSueHunt({ midMotion: [{ runId: "r1", sue: "sue-1-kid", count: 3 }] });
  assert.equal(items[0].kind, "mid-motion");
  assert.match(items[0].evidence, /3 look/);
  assert.match(items[0].action, /sue\/(body|lib\/looks)\.mjs/);
});

// Lift's 9 s voice-note fill (vn-sweep) is the page's own playback, which a person also meets half-way; a 0.6 s fade
// still running is a frame of the motion. The item names what moved so the two read apart at a glance (lift-v2 round 13).
test("mid-motion: the item names each animation that was still moving and the most it had left", () => {
  const items = rankSueHunt({
    midMotion: [
      {
        runId: "r1",
        sue: "sue-1-kid",
        count: 2,
        moving: [
          { name: "vn-sweep", remainingMs: 2658 },
          { name: "vn-sweep", remainingMs: 5100 },
        ],
      },
    ],
  });
  assert.match(items[0].evidence, /vn-sweep \(up to 5100 ms left\)/);
  assert.doesNotMatch(items[0].evidence, /vn-sweep.*vn-sweep/);
});

// lift-v2: the voice note's playback fill (vn-sweep), judged the page's own progress in round 14, came back every round.
test("mid-motion: a look taken while only the page's own progress moved (the plan's pageMotion) is not ranked; any other still is", () => {
  const items = rankSueHunt({
    midMotion: [
      { runId: "r1", sue: "sue-1-kid", count: 1, moving: [{ name: "vn-sweep", remainingMs: 2658 }] },
      { runId: "r1", sue: "sue-2-teen", count: 1, moving: [{ name: "level-up", remainingMs: 400 }] },
    ],
    pageMotion: ["vn-sweep"],
  });
  assert.deepEqual(
    items.filter((i) => i.kind === "mid-motion").map((i) => i.subject),
    ["r1/sue-2-teen"],
  );
});

test("tired-driver and the other SUE-side suspects each keep their own kind", () => {
  const items = rankSueHunt({
    suspects: [
      { kind: "tired-driver", runId: "r1", sue: "sue-1-a", lines: 2 },
      { kind: "door-refused", runId: "r1", sue: "sue-2-b", lines: 1 },
      { kind: "frozen-screen", runId: "r1", sue: "sue-3-c", lines: 1 },
      { kind: "browser-lost", runId: "r1", sue: "sue-4-d", lines: 1 },
      { kind: "code-refused", runId: "r1", sue: "sue-5-e", lines: 1 },
    ],
  });
  assert.deepEqual(new Set(kinds(items)), new Set(["tired-driver", "door-refused", "frozen-screen", "browser-lost", "code-refused"]));
  assert.match(items.find((i) => i.kind === "code-refused").action, /^sue\/body\.mjs/);
});

test("off-protocol: a driver that never made a see move is an item", () => {
  const items = rankSueHunt({ offProtocol: [{ runId: "r1", sue: "sue-1-a", why: "no see move" }] });
  assert.equal(items[0].kind, "off-protocol");
  assert.match(items[0].action, /hands-mcp\.mjs|sue-driver/);
});

test("off-protocol: when no trace anywhere records a see, the item says the trace cannot tell, once", () => {
  const items = rankSueHunt({ seeUntraced: true });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "off-protocol");
  assert.match(items[0].evidence, /trace/);
});

test("slow: a move far slower than the round's median and a Sue that never moved are items", () => {
  const items = rankSueHunt({
    slow: [
      { round: 8, who: "teen-a", perMove: 31, median: 6, moves: 10 },
      { round: 8, who: "teen-b", moves: 0 },
    ],
  });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.kind === "slow"));
  assert.ok(items.some((i) => /never moved/.test(i.evidence)));
  assert.ok(items.some((i) => /31/.test(i.evidence) && /6/.test(i.evidence)));
});

test("unstable: a persona whose verdict flipped on the same engine, driver, hands and builds says how many pairs", () => {
  const items = rankSueHunt({ unstable: [{ persona: "kid-jo", pairs: 3, flipped: 2, rounds: [7, 8] }] });
  assert.equal(items[0].kind, "unstable");
  assert.equal(items[0].subject, "kid-jo");
  assert.match(items[0].evidence, /2 of 3 pairs/);
});

test("unmeasured: decision commits with no ledger row collapse into one item; a measured commit is left out", () => {
  const items = rankSueHunt({
    decisionCommits: [
      { sha: "aaaaaaaaaaaa1111", files: ["sue/body.mjs"] },
      { sha: "bbbbbbbbbbbb2222", files: ["sue/lib/looks.mjs"] },
      { sha: "cccccccccccc3333", files: ["sue/lib/perception.mjs"] },
    ],
    measured: new Set(["cccccccccccc3333"]),
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "unmeasured");
  assert.match(items[0].evidence, /2 commit/);
  assert.match(items[0].evidence, /aaaaaaaaaa/);
  assert.doesNotMatch(items[0].evidence, /cccccccccc/);
  assert.match(items[0].action, /ab\.mjs/);
});

// 2026-10-07: `bun run save` lands on origin and leaves this checkout's main behind, holding local copies of landed
// commits under other hashes. The hunt read HEAD, so it named those copies as unmeasured after the row naming the
// landed hashes went in, and never saw what had landed since.
test("unmeasured: decision commits are read from origin/main when the checkout has it, not from a local main that lags", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sue-hunt-git-"));
  after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commitBody = (text, msg) => {
    mkdirSync(path.join(repo, "sue"), { recursive: true });
    writeFileSync(path.join(repo, "sue", "body.mjs"), text);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const root = commitBody("// root\n", "root");
  const landed = commitBody("// landed\n", "landed on origin");
  git("update-ref", "refs/remotes/origin/main", landed);
  git("reset", "-q", "--hard", root);
  const localCopy = commitBody("// landed, a local copy\n", "the same change, committed here and never pushed");
  const shas = (await decisionCommitsAsync(repo)).map((c) => c.sha);
  assert.ok(shas.includes(landed), "what landed on origin is read");
  assert.ok(!shas.includes(localCopy), "a local-only copy is not");
});

test("unmeasured: a new driver hash on the same builds with no ledger row naming it is an item", () => {
  const items = rankSueHunt({
    hashChanges: [{ round: 8, part: "driver", hash: "abc123abc123abc123", was: "def456def456" }],
    ledgerHashes: new Set(),
  });
  assert.equal(items[0].kind, "unmeasured");
  assert.match(items[0].evidence, /driver/);
  assert.deepEqual(
    rankSueHunt({ hashChanges: [{ round: 8, part: "driver", hash: "abc123abc123abc123" }], ledgerHashes: new Set(["abc123abc123abc123"]) }),
    [],
  );
});

test("ranking: no-start and unmeasured lead, then sue-side and mid-motion, then the rest; ties by subject", () => {
  const items = rankSueHunt({
    unstable: [{ persona: "z-kid", pairs: 1, flipped: 1 }],
    slow: [{ round: 1, who: "x", moves: 0 }],
    suspects: [{ kind: "tired-driver", runId: "r", sue: "sue-1-t", lines: 1 }],
    offProtocol: [{ runId: "r", sue: "sue-1-o" }],
    midMotion: [{ runId: "r", sue: "sue-1-m", count: 1 }],
    sueSide: [{ runId: "r", sue: "sue-1-s", finding: "sue-1-s:1", why: "x" }],
    decisionCommits: [{ sha: "dddddddddddd4444", files: ["sue/body.mjs"] }],
    noStart: [
      { round: 2, subject: "round 2", why: "b" },
      { round: 1, subject: "round 1", why: "a" },
    ],
  });
  const order = kinds(items);
  const rank = (k) => order.indexOf(k);
  assert.ok(rank("no-start") < rank("sue-side"));
  assert.ok(rank("unmeasured") < rank("sue-side"));
  assert.ok(rank("sue-side") < rank("mid-motion"));
  assert.ok(rank("mid-motion") < rank("off-protocol"));
  for (const low of ["tired-driver", "slow", "unstable"]) assert.ok(rank("mid-motion") < rank(low));
  const starts = items.filter((i) => i.kind === "no-start").map((i) => i.subject);
  assert.deepEqual(starts, ["round 1", "round 2"]);
  assert.ok(items.every((i) => i.weight > 0 && i.evidence && i.action));
});

test("renderSueHunt: heaviest first with a top cut, and the empty case says so", () => {
  const items = rankSueHunt({
    noStart: [{ round: 1, subject: "round 1", why: "x" }],
    unstable: [{ persona: "a", pairs: 1, flipped: 1 }],
    slow: [{ round: 1, who: "w", moves: 0 }],
  });
  const text = renderSueHunt(items, { top: 2 });
  assert.match(text, /^SUE HUNT: 3 item\(s\), heaviest first/);
  assert.equal(text.includes("round 1"), true);
  assert.match(text, /\+ 1 more/);
  assert.match(
    renderSueHunt([], { rounds: 3 }),
    /SUE HUNT: nothing SUE can see wrong with itself in the last 3 rounds - say so, that statement is itself the audit\./,
  );
});

// ---- gatherSueHunt over a fixture workspace ----

const tmp = mkdtempSync(path.join(tmpdir(), "sue-hunt-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const jsonl = (file, rows) => json(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const PARTS = { engine: "e1", driver: "d1", hands: "h1", docs: "x", args: "y" };
const BUILDS = { "https://a/": "b1" };
const T = (n) => `2026-10-${String(n).padStart(2, "0")}T12:00:00.000Z`;

function sueFolder(runsDir, runId, name, { summary = {}, findings = [], trace = [], sees = null, repro = null, reuse = null } = {}) {
  const dir = path.join(runsDir, runId, name);
  json(path.join(dir, "summary.json"), { sueId: name, outcome: "left", ...summary });
  jsonl(path.join(dir, "findings.jsonl"), findings);
  jsonl(path.join(dir, "trace.jsonl"), trace);
  if (sees) jsonl(path.join(dir, "sees.jsonl"), sees);
  if (repro) json(path.join(runsDir, runId, "repro.json"), repro);
  if (reuse) json(path.join(dir, "reuse.json"), reuse);
}
const moves = (n, ms = 1000, base = Date.parse(T(5))) =>
  Array.from({ length: n }, (_, i) => ({ at: new Date(base + i * ms).toISOString(), tool: i === 0 ? "look" : "click", ms: 50 }));

function fixture() {
  const workspace = path.join(tmp, "ws");
  const runsDir = path.join(workspace, "runs");
  const series = "fx";
  // Two rounds; round 2's second person never started, her sibling ended as a brain error.
  for (const [n, stars] of [
    [1, 4],
    [2, 3],
  ]) {
    const ids = [`r${n}a`, `r${n}b`];
    writeRound(workspace, seriesKey(series, "people"), {
      id: T(n),
      at: T(n),
      series,
      kind: "people",
      runIds: n === 2 ? [ids[0]] : ids,
      people: 2,
      critics: [],
      stars,
      finished: 1,
      each: [
        { who: "kid-a", stars, finished: true },
        { who: "kid-b", stars: n === 1 ? 4 : 2, finished: n === 1 },
      ],
    });
  }
  const reuse = (round) => ({ parts: PARTS, builds: BUILDS, round, at: round });
  sueFolder(runsDir, "r1a", "sue-1-kid-a", { reuse: reuse(T(1)), trace: moves(6) });
  sueFolder(runsDir, "r1b", "sue-2-kid-b", { reuse: reuse(T(1)), trace: moves(6) });
  sueFolder(runsDir, "r2a", "sue-3-kid-a", {
    summary: { outcome: "brain-error" },
    reuse: reuse(T(2)),
    trace: moves(6),
    findings: [
      { at: T(2), source: "body", kind: "look-mid-motion", text: "a look while an animation ran" },
      { at: T(2), source: "body", kind: "look-mid-motion", text: "again" },
      { at: T(2), source: "brain", kind: "thought", text: "x" },
    ],
    repro: {
      entries: [{ finding: "sue-3-kid-a:3", status: "rejected", bucket: "sue-side", why: "her browser was closed under her", at: T(2) }],
    },
  });
  return { workspace, runsDir, series };
}

test("gatherSueHunt reads every signal from the fixture workspace", () => {
  const { workspace, runsDir, series } = fixture();
  const items = gatherSueHunt({ workspace, series, runsDir, root: tmp, limit: 3 });
  const k = kinds(items);
  assert.ok(k.includes("no-start"), `no-start missing in ${k}`);
  assert.match(first(items, "no-start").evidence, /round 2/);
  assert.ok(k.includes("sue-side"));
  assert.match(first(items, "sue-side").evidence, /her browser was closed/);
  assert.ok(k.includes("mid-motion"));
  assert.match(first(items, "mid-motion").evidence, /2 look/);
  // kid-a: same parts and builds in both rounds, stars 4 -> 3: a flip. kid-b started in round 1 only.
  const unstable = first(items, "unstable");
  assert.ok(unstable, `unstable missing in ${k}`);
  assert.equal(unstable.subject, "kid-a");
  assert.match(unstable.evidence, /1 of 1 pairs/);
  // No driver ever saw a see move in these traces: said once.
  assert.ok(items.some((i) => i.kind === "off-protocol"));
  assert.equal(items[0].kind, "no-start");
});

test("gatherSueHunt reports nothing for a workspace with no rounds, and never writes to it", () => {
  const empty = path.join(tmp, "empty");
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(gatherSueHunt({ workspace: empty, series: "none", runsDir: path.join(empty, "runs"), root: tmp, limit: 3 }), []);
});

test("a driver whose sees.jsonl records a `see` looked: only the one who never did is off-protocol, and the trace is not called blind", () => {
  const workspace = path.join(tmp, "ws-see");
  const runsDir = path.join(workspace, "runs");
  const series = "fx-see";
  writeRound(workspace, seriesKey(series, "people"), {
    id: T(7),
    at: T(7),
    series,
    kind: "people",
    runIds: ["s1", "s2"],
    people: 2,
    critics: [],
    stars: 4,
    finished: 2,
    each: [
      { who: "kid-a", stars: 4, finished: true },
      { who: "kid-b", stars: 4, finished: true },
    ],
  });
  sueFolder(runsDir, "s1", "sue-1-kid-a", { trace: moves(4), sees: [{ at: T(7), picture: "001.jpg", answered: "image" }] });
  sueFolder(runsDir, "s2", "sue-2-kid-b", { trace: moves(4) });
  const off = gatherSueHunt({ workspace, series, runsDir, root: tmp, limit: 3 }).filter((i) => i.kind === "off-protocol");
  assert.deepEqual(
    off.map((i) => i.subject),
    ["s2/sue-2-kid-b"],
  );
});

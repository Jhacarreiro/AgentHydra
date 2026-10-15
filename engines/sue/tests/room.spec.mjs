/**
 * room.spec - the focus group's table (lib/room.mjs): who sits where, what they said, the problems
 * on the table, the vote, the verdict, and the fix loop that hands the last verdict to the next room.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  appendLine,
  conclude,
  focusGroupBrief,
  isFocusGroup,
  lastVerdictFor,
  markGone,
  moderatorBrief,
  MODERATOR_ID,
  openRoom,
  phaseOf,
  readHeard,
  readLines,
  readVerdict,
  recordVerdict,
  renderRoomForModerator,
  renderRoomForSue,
  roomSnapshot,
  sayLine,
  seatsOf,
  tally,
  unheard,
  voteShouldClose,
  waitForNews,
  writeHeard,
  writeRoster,
} from "../lib/room.mjs";

const scratch = [];
afterEach(() => {
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const GRANDMA = { id: "sue-1117-grandma", name: "Grandma Sue 1117", persona: "grandma" };
const TIKTOK = { id: "sue-1118-tiktok", name: "TikTok Sue 1118", persona: "tiktok" };
const BOB = { id: "sue-1119-bob", name: "Bob 1119", persona: "bob" };

function freshRoom({ suggestions = [], previous = null } = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "sue-room-"));
  scratch.push(runDir);
  openRoom(runDir, {
    url: "https://example.test/start",
    intent: "a friend sent this link; you want to see what it is for",
    suggestions,
    previous,
  });
  writeRoster(runDir, [GRANDMA, TIKTOK, BOB]);
  return runDir;
}

let tick = Date.parse("2026-09-23T12:00:00.000Z");
const at = () => new Date((tick += 1000));

test("a run is a focus group once its room is opened, and not before", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "sue-room-"));
  scratch.push(bare);
  assert.equal(isFocusGroup(bare), false);
  const runDir = freshRoom();
  assert.equal(isFocusGroup(runDir), true);
  assert.equal(roomSnapshot(bare), null);
});

test("lines from different speakers come back in the order they were said, each with its own id", () => {
  const runDir = freshRoom();
  appendLine(runDir, GRANDMA.id, { kind: "journal", name: GRANDMA.name, text: "I cannot find the price", noteKind: "confusion" }, at());
  appendLine(runDir, TIKTOK.id, { kind: "say", name: TIKTOK.name, text: "same, where is it" }, at());
  appendLine(runDir, MODERATOR_ID, { kind: "ask", name: "The moderator", text: "What did you expect to see first?" }, at());
  const lines = readLines(runDir);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["journal", "say", "ask"],
  );
  assert.equal(new Set(lines.map((l) => l.id)).size, 3);
  assert.match(sayLine(lines[0]), /Grandma Sue 1117 wrote in her diary \(confusion\): "I cannot find the price"/);
  assert.match(sayLine(lines[2]), /^The moderator asks: /);
});

test("a line said after reading the room is heard after everything in it, even inside one clock tick", () => {
  const runDir = freshRoom();
  // Her line carries a time at or past this process's clock (another process, the same millisecond).
  const hers = appendLine(runDir, TIKTOK.id, { kind: "say", name: TIKTOK.name, text: "where is the price" }, new Date(Date.now() + 5000));
  const host = appendLine(runDir, "host", { kind: "say", name: "The host", text: "What made you stop?" });
  assert.ok(Date.parse(host.at) > Date.parse(hers.at), "the host's line is stamped after hers");
  assert.equal(readLines(runDir).at(-1).id, host.id, "everyone hears the host's line next");
});

test("a speaker id that could escape the room's folder is refused", () => {
  const runDir = freshRoom();
  assert.throws(() => appendLine(runDir, "../evil", { kind: "say", text: "hi" }), /not a speaker/);
  assert.throws(() => appendLine(runDir, GRANDMA.id, { kind: "shout", text: "hi" }), /not a kind of line/);
});

test("a long line is cut and marked, and a query string never lands in the room", () => {
  const runDir = freshRoom();
  const line = appendLine(
    runDir,
    GRANDMA.id,
    { kind: "journal", text: "x".repeat(5000), url: "https://example.test/a?token=secret#frag" },
    at(),
  );
  assert.ok(line.text.length <= 1200);
  assert.ok(line.text.endsWith("…"));
  assert.equal(line.url, "https://example.test/a");
});

test("each listener hears only what she has not heard, and never her own words", () => {
  const runDir = freshRoom();
  appendLine(runDir, GRANDMA.id, { kind: "say", name: GRANDMA.name, text: "hello" }, at());
  appendLine(runDir, TIKTOK.id, { kind: "say", name: TIKTOK.name, text: "hey" }, at());
  const heardFile = path.join(runDir, "heard.json");
  const heard = readHeard(heardFile);
  const news = unheard(readLines(runDir), heard, GRANDMA.id);
  assert.deepEqual(
    news.map((l) => l.text),
    ["hey"],
  );
  for (const l of news) heard.add(l.id);
  writeHeard(heardFile, heard);
  assert.deepEqual(unheard(readLines(runDir), readHeard(heardFile), GRANDMA.id), []);
});

test("waitForNews answers as soon as somebody speaks, and an empty list when nobody does", async () => {
  const runDir = freshRoom();
  const heard = new Set();
  let slept = 0;
  const quiet = await waitForNews(runDir, { heard, listener: GRANDMA.id, seconds: 0, sleep: async () => (slept += 1) });
  assert.deepEqual(quiet, []);
  let calls = 0;
  const news = await waitForNews(runDir, {
    heard,
    listener: GRANDMA.id,
    seconds: 5,
    everyMs: 1,
    sleep: async () => {
      calls += 1;
      if (calls === 2) appendLine(runDir, TIKTOK.id, { kind: "say", name: TIKTOK.name, text: "anyone there?" }, at());
    },
  });
  assert.deepEqual(
    news.map((l) => l.text),
    ["anyone there?"],
  );
});

test("the room moves from visiting to the table when everyone has left the website, or when the moderator gathers them", () => {
  const runDir = freshRoom();
  assert.equal(phaseOf(runDir), "visiting");
  appendLine(runDir, GRANDMA.id, { kind: "left-page", name: GRANDMA.name, text: "I give up" }, at());
  appendLine(runDir, TIKTOK.id, { kind: "left-page", name: TIKTOK.name, text: "done" }, at());
  assert.equal(phaseOf(runDir), "visiting");
  const seats = seatsOf(readLines(runDir), [GRANDMA, TIKTOK, BOB]);
  assert.deepEqual(
    seats.map((s) => s.state),
    ["table", "table", "looking"],
  );
  appendLine(runDir, BOB.id, { kind: "left-page", name: BOB.name, text: "found it" }, at());
  assert.equal(phaseOf(runDir), "table");

  const other = freshRoom();
  appendLine(other, MODERATOR_ID, { kind: "gather", name: "The moderator", text: "time's up, come sit down" }, at());
  assert.equal(phaseOf(other), "table");
});

test("a vote either puts a new problem on the table or backs one by its line; only a Sue's latest vote counts", () => {
  const runDir = freshRoom();
  const p1 = appendLine(
    runDir,
    GRANDMA.id,
    { kind: "vote", name: GRANDMA.name, text: "I never found out what it costs", why: "there is no price anywhere" },
    at(),
  );
  const p2 = appendLine(runDir, TIKTOK.id, { kind: "vote", name: TIKTOK.name, text: "the sign-up asks too much" }, at());
  appendLine(runDir, BOB.id, { kind: "vote", name: BOB.name, text: "backing 2", ref: p2.id }, at());
  let table = tally(readLines(runDir), [GRANDMA, TIKTOK, BOB]);
  assert.deepEqual(
    table.map((p) => [p.n, p.backers.length]),
    [
      [1, 1],
      [2, 2],
    ],
  );
  // Bob changes his mind: he moves, he is never counted twice.
  appendLine(runDir, BOB.id, { kind: "vote", name: BOB.name, text: "backing 1", ref: p1.id, why: "grandma is right, no price" }, at());
  table = tally(readLines(runDir), [GRANDMA, TIKTOK, BOB]);
  assert.deepEqual(
    table.map((p) => [p.n, p.backers.map((b) => b.name)]),
    [
      [1, ["Grandma Sue 1117", "Bob 1119"]],
      [2, ["TikTok Sue 1118"]],
    ],
  );
});

test("the moderator's conclude writes the verdict once, with who agreed, who did not and their own words", () => {
  const runDir = freshRoom({ previous: { problem: "the page was blank on phones", at: "2026-09-20T00:00:00.000Z" } });
  const p1 = appendLine(
    runDir,
    GRANDMA.id,
    { kind: "vote", name: GRANDMA.name, text: "no price anywhere", why: "I looked everywhere" },
    at(),
  );
  appendLine(runDir, TIKTOK.id, { kind: "vote", name: TIKTOK.name, text: "too slow" }, at());
  appendLine(runDir, BOB.id, { kind: "vote", name: BOB.name, ref: p1.id, text: "", why: "same for me" }, at());
  const { verdict, already } = conclude(runDir, {
    by: "moderator",
    proposal: 1,
    summary: "Two of three never found a price.",
    lastProblemStillThere: "no",
    now: at(),
  });
  assert.equal(already, false);
  assert.equal(verdict.problem, "no price anywhere");
  assert.deepEqual(verdict.agreedBy, ["Grandma Sue 1117", "Bob 1119"]);
  assert.deepEqual(verdict.against, ["TikTok Sue 1118"]);
  assert.equal(verdict.decidedBy, "moderator");
  assert.equal(verdict.lastProblem, "the page was blank on phones");
  assert.equal(verdict.lastProblemStillThere, "no");
  assert.ok(verdict.quotes.some((q) => q.text === "I looked everywhere"));
  assert.ok(verdict.quotes.some((q) => q.name === "Bob 1119" && q.text === "same for me"));
  assert.equal(phaseOf(runDir), "closed");
  // A second conclude never overwrites the first.
  const again = conclude(runDir, { by: "vote", now: at() });
  assert.equal(again.already, true);
  assert.equal(again.verdict.problem, "no price anywhere");
  assert.equal(readLines(runDir).filter((l) => l.kind === "verdict").length, 1);
});

test("conclude refuses a problem number that is not on the table", () => {
  const runDir = freshRoom();
  appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, at());
  assert.throws(() => conclude(runDir, { by: "moderator", proposal: 4 }), /no problem number 4/);
  assert.equal(readVerdict(runDir), null);
});

test("the vote closes the room only when everyone at the table has voted and the moderator had its chance", () => {
  const runDir = freshRoom();
  const now = Date.parse("2026-09-23T13:00:00.000Z");
  for (const s of [GRANDMA, TIKTOK, BOB]) appendLine(runDir, s.id, { kind: "left-page", name: s.name, text: "" }, new Date(now - 600_000));
  const p1 = appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, new Date(now - 500_000));
  appendLine(runDir, TIKTOK.id, { kind: "vote", name: TIKTOK.name, ref: p1.id, text: "" }, new Date(now - 400_000));
  assert.equal(voteShouldClose(runDir, { now }), false, "Bob has not voted");
  appendLine(runDir, BOB.id, { kind: "vote", name: BOB.name, text: "too slow" }, new Date(now - 60_000));
  assert.equal(voteShouldClose(runDir, { now, graceMs: 180_000 }), false, "the moderator still has time");
  assert.equal(voteShouldClose(runDir, { now: now + 200_000, graceMs: 180_000 }), true);
  const { verdict } = conclude(runDir, { by: "vote", now: new Date(now + 200_000) });
  assert.equal(verdict.problem, "no price");
  assert.equal(verdict.decidedBy, "vote");
  assert.deepEqual(verdict.agreedBy, ["Grandma Sue 1117", "TikTok Sue 1118"]);
  assert.equal(readLines(runDir).at(-1).from, "room");
});

// Run 20260925-074931-2d5f: the vote closed the room 13 seconds before the moderator put the
// builders' guesses, and nobody ever answered them.
test("the vote holds the room until every Sue at the table has answered the builders' guesses, or the hold runs out", () => {
  const runDir = freshRoom({ suggestions: ["we think the price is hidden"] });
  const now = Date.parse("2026-09-25T13:00:00.000Z");
  for (const s of [GRANDMA, TIKTOK, BOB]) appendLine(runDir, s.id, { kind: "left-page", name: s.name, text: "" }, new Date(now - 600_000));
  const p1 = appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, new Date(now - 500_000));
  for (const s of [TIKTOK, BOB]) appendLine(runDir, s.id, { kind: "vote", name: s.name, ref: p1.id, text: "" }, new Date(now - 400_000));
  assert.equal(voteShouldClose(runDir, { now: now - 150_000 }), false, "the guesses were never put: the vote waits a while longer");
  const asked = appendLine(
    runDir,
    MODERATOR_ID,
    { kind: "ask", name: "The moderator", text: "We think the price is hidden. Agree?", guesses: true },
    new Date(now - 5_000),
  );
  assert.equal(asked.guesses, true, "the guesses ask is marked on its line");
  assert.equal(voteShouldClose(runDir, { now }), false, "the guesses are on the table and nobody has answered");
  appendLine(runDir, GRANDMA.id, { kind: "say", name: GRANDMA.name, text: "No, the price was fine." }, new Date(now + 10_000));
  appendLine(runDir, TIKTOK.id, { kind: "say", name: TIKTOK.name, text: "Same." }, new Date(now + 20_000));
  assert.equal(voteShouldClose(runDir, { now: now + 30_000 }), false, "Bob has not answered yet");
  appendLine(runDir, BOB.id, { kind: "say", name: BOB.name, text: "Not the price." }, new Date(now + 40_000));
  assert.equal(voteShouldClose(runDir, { now: now + 50_000 }), true, "every Sue at the table has answered");

  const quiet = freshRoom({ suggestions: ["we think the price is hidden"] });
  for (const s of [GRANDMA, TIKTOK, BOB]) appendLine(quiet, s.id, { kind: "left-page", name: s.name, text: "" }, new Date(now - 600_000));
  const q1 = appendLine(quiet, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, new Date(now - 500_000));
  for (const s of [TIKTOK, BOB]) appendLine(quiet, s.id, { kind: "vote", name: s.name, ref: q1.id, text: "" }, new Date(now - 400_000));
  assert.equal(voteShouldClose(quiet, { now: now + 30_000 }), true, "nobody put the guesses in time: the hold is bounded");
  appendLine(
    quiet,
    MODERATOR_ID,
    { kind: "ask", name: "The moderator", text: "We think the price is hidden.", guesses: true },
    new Date(now),
  );
  assert.equal(voteShouldClose(quiet, { now: now + 30_000 }), false, "a late guesses ask still gets its answers");
  assert.equal(voteShouldClose(quiet, { now: now + 200_000 }), true, "a guesses ask nobody answers holds the room only so long");
});

test("a tie goes to the problem put on the table first, and no votes at all is no verdict", () => {
  const runDir = freshRoom();
  appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "first" }, at());
  appendLine(runDir, TIKTOK.id, { kind: "vote", name: TIKTOK.name, text: "second" }, at());
  assert.equal(conclude(runDir, { by: "vote" }).verdict.problem, "first");
  const empty = freshRoom();
  assert.deepEqual(conclude(empty, { by: "vote" }), { verdict: null, already: false });
  assert.equal(readVerdict(empty), null);
});

test("a Sue at the table is shown the problems and asked to vote; a Sue still browsing is not shown the table", () => {
  const runDir = freshRoom();
  appendLine(runDir, TIKTOK.id, { kind: "vote", name: TIKTOK.name, text: "too slow" }, at());
  appendLine(runDir, MODERATOR_ID, { kind: "ask", name: "The moderator", text: "What felt off?" }, at());
  const browsing = renderRoomForSue({ runDir, me: GRANDMA.id, news: [] });
  assert.doesNotMatch(browsing, /problems on the table/);
  assert.match(browsing, /The moderator's latest question: "What felt off\?"/);
  appendLine(runDir, GRANDMA.id, { kind: "left-page", name: GRANDMA.name, text: "" }, at());
  const seated = renderRoomForSue({ runDir, me: GRANDMA.id, news: readLines(runDir).filter((l) => l.from !== GRANDMA.id) });
  assert.match(seated, /1\. "too slow" \(put there by TikTok Sue 1118; backed by TikTok Sue 1118\)/);
  assert.match(seated, /You have not voted yet/);
  assert.match(seated, /Around the table: TikTok Sue 1118 \(still on the website, has voted\); Bob 1119 \(still on the website\)/);
});

test("the moderator sees the phase, who has not voted and the verdict once there is one", () => {
  const runDir = freshRoom();
  for (const s of [GRANDMA, TIKTOK, BOB]) appendLine(runDir, s.id, { kind: "left-page", name: s.name, text: "" }, at());
  appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, at());
  const text = renderRoomForModerator({ runDir, news: [] });
  assert.match(text, /Phase: at the table/);
  assert.match(text, /Not voted yet: TikTok Sue 1118, Bob 1119/);
  conclude(runDir, { by: "moderator", proposal: 1, now: at() });
  assert.match(renderRoomForModerator({ runDir, news: [] }), /The room agreed: "no price" \(decided by moderator\)\. You are finished\./);
});

test("the briefs name the others, the caller's suggestions and the last room's verdict, and only the moderator hears the last two", () => {
  const roster = [GRANDMA, TIKTOK, BOB];
  const sue = focusGroupBrief({ me: GRANDMA.id, roster });
  assert.match(sue, /one of 3 people in a focus group/);
  assert.match(sue, /TikTok Sue 1118, Bob 1119/);
  assert.doesNotMatch(sue, /Grandma Sue 1117,/);
  const mod = moderatorBrief({
    meta: {
      url: "https://example.test",
      intent: "why",
      suggestions: ["the price is hidden"],
      previous: { problem: "blank on phones", at: "2026-09-20T00:00:00.000Z" },
    },
    roster,
  });
  assert.match(mod, /- the price is hidden/);
  assert.match(mod, /The LAST focus group on this page \(2026-09-20\) agreed the biggest problem was: "blank on phones"/);
  assert.doesNotMatch(sue, /price is hidden|blank on phones/);
});

test("every verdict is booked per page, upserted by run, and the next room reads the last one", () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "sue-store-"));
  scratch.push(store);
  const verdict = (problem, iso) => ({ problem, at: iso, decidedBy: "vote", agreedBy: ["a", "b"], size: 3, lastProblemStillThere: null });
  recordVerdict(store, {
    runId: "r1",
    pageKey: "example.test/start",
    url: "https://example.test/start",
    verdict: verdict("no price", "2026-09-20T00:00:00.000Z"),
  });
  recordVerdict(store, {
    runId: "r2",
    pageKey: "example.test/start",
    url: "https://example.test/start",
    build: { commit: "abc123" },
    verdict: verdict("too slow", "2026-09-21T00:00:00.000Z"),
  });
  recordVerdict(store, {
    runId: "r2",
    pageKey: "example.test/start",
    url: "https://example.test/start",
    build: { commit: "abc123" },
    verdict: verdict("too slow", "2026-09-21T00:00:00.000Z"),
  });
  recordVerdict(store, {
    runId: "r3",
    pageKey: "other.test",
    url: "https://other.test",
    verdict: verdict("other", "2026-09-22T00:00:00.000Z"),
  });
  const last = lastVerdictFor(store, "example.test/start");
  assert.equal(last.problem, "too slow");
  assert.equal(last.build, "abc123");
  assert.equal(last.agreedBy, 2);
  assert.equal(fs.readFileSync(path.join(store, "focus-groups.jsonl"), "utf8").trim().split("\n").length, 3);
  assert.equal(lastVerdictFor(store, "nobody.test"), null);
});

test("the snapshot is the room's whole public picture", () => {
  const runDir = freshRoom();
  appendLine(runDir, GRANDMA.id, { kind: "journal", name: GRANDMA.name, text: "where is the price", noteKind: "confusion" }, at());
  appendLine(runDir, GRANDMA.id, { kind: "left-page", name: GRANDMA.name, text: "" }, at());
  appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, at());
  const snap = roomSnapshot(runDir);
  assert.equal(snap.phase, "visiting");
  assert.equal(snap.meta.url, "https://example.test/start");
  assert.deepEqual(
    snap.seats.map((s) => [s.name, s.state, s.voted]),
    [
      ["Grandma Sue 1117", "table", true],
      ["TikTok Sue 1118", "looking", false],
      ["Bob 1119", "looking", false],
    ],
  );
  assert.deepEqual(snap.table, [{ n: 1, text: "no price", by: "Grandma Sue 1117", why: null, backers: ["Grandma Sue 1117"] }]);
  assert.equal(snap.lines[0].noteKind, "confusion");
  assert.equal(snap.verdict, null);
});

test("a Sue whose visit ended without a goodbye leaves the room, so the vote can close without her", () => {
  const runDir = freshRoom();
  appendLine(runDir, GRANDMA.id, { kind: "left-page", name: GRANDMA.name, text: "" }, at());
  appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, at());
  appendLine(runDir, GRANDMA.id, { kind: "left", name: GRANDMA.name, text: "" }, at());
  const ghost = markGone(runDir, TIKTOK.id, { why: "her browser died", now: at() });
  assert.equal(ghost.kind, "left");
  assert.equal(ghost.name, TIKTOK.name);
  assert.equal(ghost.text, "(her browser died)");
  assert.equal(markGone(runDir, GRANDMA.id, { now: at() }), null, "a Sue who already left is left alone");
  assert.equal(markGone(runDir, "nobody-here", { now: at() }), null, "a stranger is not seated");
  assert.equal(voteShouldClose(runDir), false, "Bob is still on the website");
  markGone(runDir, BOB.id, { now: at() });
  assert.equal(voteShouldClose(runDir), true, "everyone has gone and somebody voted");
  assert.deepEqual(
    seatsOf(readLines(runDir), [GRANDMA, TIKTOK, BOB]).map((s) => s.state),
    ["gone", "gone", "gone"],
  );
});

test("a Sue whose visit ends after the verdict still leaves, so a closed room does not hold a ghost forever", () => {
  const runDir = freshRoom();
  appendLine(runDir, GRANDMA.id, { kind: "left-page", name: GRANDMA.name, text: "" }, at());
  appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price" }, at());
  conclude(runDir, { by: "moderator", problem: "no price", now: at() });
  // Her brain died in the exit interview, before her own goodbye (review finding, 2026-09-23): the seat
  // stayed at the table and the Sue Manager kept offering a composer on a finished run.
  const ghost = markGone(runDir, GRANDMA.id, { why: "her visit ended", now: at() });
  assert.equal(ghost?.kind, "left");
  assert.equal(seatsOf(readLines(runDir), [GRANDMA, TIKTOK, BOB])[0].state, "gone");
  assert.equal(markGone(runDir, GRANDMA.id, { now: at() }), null, "and only once");
});

test("a game's moderator goes round the screens before the vote; a website's brief is unchanged", () => {
  const meta = { url: "https://example.test", intent: "why" };
  assert.doesNotMatch(moderatorBrief({ meta, roster: [GRANDMA, TIKTOK] }), /worst screen/);
  const game = moderatorBrief({ meta: { ...meta, judges: true }, roster: [GRANDMA, TIKTOK] });
  assert.match(game, /before anyone votes, go round the table screen by screen/);
  assert.ok(game.indexOf("worst screen") < game.indexOf("Get everyone to vote"), "the round comes before the vote");
});

/**
 * move-batch.spec - a move that changes the screen answers with the look that follows it, and `do` runs
 * a screen's notes and its one move in one call (lib/move-batch.mjs, applied by lib/body-relay.mjs above
 * whatever body a Sue has). The body here is an in-process stand-in through the relay's `startBodyImpl`
 * seam: it keeps a real clock (lib/clock.mjs) and writes trace.jsonl the way body.mjs does, one row per
 * call, so the specs can count rows and compare a visit's simulated time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createBodyRelay } from "../lib/body-relay.mjs";
import { createClock } from "../lib/clock.mjs";
import { changesScreen, destructiveChoice, planBatch, renumberStale } from "../lib/move-batch.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const DIALS = { attentionSeconds: 60, patienceSeconds: 600, wordsPerMinute: 200 };
const HOME_SCREEN = "Welcome to the shop\n[1] Pricing\n[2] Contact us\n[3] Sign in";
const DANGER_SCREEN = "Your account\n[1] Save changes\n[2] Delete my account";
const HEADER_SCREEN = "Courses\n[1] Sign out\n[2] Reset filters\n[3] Remove filter: Price\n[4] Open course\n[5] Unsubscribe";

/** A body with body.mjs's habits: a clock charged per call, one trace row per call, a look that reads the screen. */
function fakeBody(sueDir, { screen = HOME_SCREEN, afterClick = null, clock = createClock(DIALS) } = {}) {
  const seen = [];
  const state = { screen };
  // Like body.mjs: the relay names its batch in `_batch`, and the row carries it as it is written.
  const trace = (tool, args, batch) => {
    fs.appendFileSync(
      path.join(sueDir, "trace.jsonl"),
      `${JSON.stringify({ tool, args, clock: { elapsedSeconds: clock.elapsedSeconds() }, ...(batch ? { batch } : {}) })}\n`,
    );
    seen.push(tool);
  };
  const ok = (line) => ({ content: [{ type: "text", text: line }] });
  const handlers = {
    look: () => {
      clock.read(state.screen.split(/\s+/).length);
      return {
        content: [
          { type: "image", data: Buffer.from("jpg").toString("base64"), mimeType: "image/jpeg" },
          { type: "text", text: state.screen },
        ],
      };
    },
    click: ({ target }) => {
      clock.charge({ actions: 1 });
      state.screen = afterClick ?? `You are on page ${target}\n[1] Back\n[2] Delete my account`;
      // The live body's own words: the folded answer must drop the whole sentence, not leave " to see what happened."
      return ok(`Clicked ${target}. Call look to see what happened.`);
    },
    scroll: () => {
      clock.charge({ actions: 1 });
      return ok("Scrolled. Call look.");
    },
    note: ({ text }) =>
      text === "BROKEN" ? { content: [{ type: "text", text: "Could not write that note." }], isError: true } : ok(`Noted: ${text}`),
    done: () => ok("Finished."),
  };
  const schema = { type: "object", properties: { target: { type: ["number", "string"] } } };
  return {
    seen,
    clock,
    state,
    tools: Object.keys(handlers).map((name) => ({ name, description: name, inputSchema: schema })),
    call: async (name, given) => {
      const { _batch, ...args } = given ?? {};
      const result = handlers[name](args);
      trace(name, given && Object.keys(args).length ? args : undefined, _batch);
      return result;
    },
    exited: new Promise(() => {}),
    close: async () => {},
  };
}

async function openRun({ now, ...opts } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-batch-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const runDir = path.join(home, "runs", "r1");
  const sueDir = path.join(runDir, "sue-1-test");
  fs.mkdirSync(sueDir, { recursive: true });
  const body = fakeBody(sueDir, opts);
  const relay = createBodyRelay({ runDir, bodyFile: "unused", startBodyImpl: async () => body, ...(now ? { now } : {}) });
  relay.register({ sueId: "sue-1-test", sueDir, brief: "b", persona: "p" });
  cleanups.push(() => relay.close());
  const move = async (tool, args) => (await relay.move({ sue: "sue-1-test", tool, args })).body;
  const trace = () =>
    fs
      .readFileSync(path.join(sueDir, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return { body, move, trace, tracePath: path.join(sueDir, "trace.jsonl") };
}

const words = (answer) => answer.content.map((c) => c.text).join("\n");

test("a click answers with its own line and then the look that follows it", async () => {
  const { move, trace } = await openRun();
  await move("look");
  const answer = await move("click", { target: 1 });
  assert.match(words(answer), /^Clicked 1\.\n\[what you see: .*\.jpg - Read it before her next move: [^\]]+\]\nYou are on page 1/);
  assert.deepEqual(
    trace().map((r) => r.tool),
    ["look", "click", "look"],
    "the folded look is its own trace row, as a separate look was",
  );
  const asked = await move("look");
  assert.match(words(asked), /\.jpg/, "look is still a move");
});

test("do runs the notes and the click in order, one trace row each, tagged with its batch", async () => {
  const { move, trace } = await openRun();
  await move("look");
  const answer = await move("do", {
    moves: [
      { move: "note", kind: "thought", text: "pricing is hidden" },
      { move: "click", target: 1 },
    ],
  });
  const said = words(answer);
  assert.ok(said.indexOf("Noted: pricing is hidden") < said.indexOf("Clicked 1."), "results come in the order given");
  assert.ok(said.indexOf("Clicked 1.") < said.indexOf("You are on page 1"), "the new look comes last");
  const rows = trace();
  assert.deepEqual(
    rows.map((r) => r.tool),
    ["look", "note", "click", "look"],
  );
  assert.deepEqual(
    rows.map((r) => r.batch),
    [undefined, 1, 1, 1],
  );
  assert.deepEqual(rows[1].args, { kind: "thought", text: "pricing is hidden" });
});

test("a note step in a do reaches the body with its typed problem and its same as sent", async () => {
  const { move, trace } = await openRun();
  await move("look");
  const problem = {
    title: "The Pricing link does nothing",
    defect: "issue",
    severity: 4,
    expected: "The pricing page opens",
    actual: 'The screen still says "Welcome to the shop"',
    steps: ["Open the shop", "Click Pricing"],
  };
  await move("do", {
    moves: [
      { move: "note", kind: "broken", text: "nothing happens", problem },
      { move: "note", kind: "annoyance", text: "that again", same: 2 },
      { move: "click", target: 1 },
    ],
  });
  const notes = trace().filter((r) => r.tool === "note");
  assert.deepEqual(
    notes.map((r) => r.args),
    [
      { kind: "broken", text: "nothing happens", problem },
      { kind: "annoyance", text: "that again", same: 2 },
    ],
    "the nested problem is never flattened or turned into text on the way",
  );
});

test("a do with two moves that change the screen is refused and nothing runs", async () => {
  const { move, trace } = await openRun();
  await move("look");
  const answer = await move("do", {
    moves: [
      { move: "click", target: 1 },
      { move: "scroll", direction: "down" },
    ],
  });
  assert.equal(answer.isError, true);
  assert.match(words(answer), /at most ONE move that changes the screen.*see the screen between/);
  assert.deepEqual(
    trace().map((r) => r.tool),
    ["look"],
  );
  const other = await move("do", { moves: [{ move: "done" }] });
  assert.match(words(other), /"done" is made on its own/);
});

test("a screen that offers Delete stops a do before its move, and the move alone goes through", async () => {
  const { move, trace, body } = await openRun({ screen: DANGER_SCREEN });
  await move("look");
  const answer = await move("do", {
    moves: [
      { move: "note", kind: "thought", text: "that Delete button is huge" },
      { move: "click", target: 2 },
    ],
  });
  assert.match(words(answer), /Your notes are written, but your move \(click\) was NOT made.*\[2\] Delete my account.*on its own/);
  assert.deepEqual(
    trace().map((r) => r.tool),
    ["look", "note"],
    "the notes ran, the click did not",
  );
  assert.ok(!body.seen.includes("click"));
  const single = await move("click", { target: 2 });
  assert.match(words(single), /^Clicked 2\./);
});

test("a visit's simulated time is the same whether she moves one at a time, in a do, or looks by hand", async () => {
  // The old way: note, click, then a separate look, straight on a body.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sue-batch-old-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = fakeBody(dir);
  await old.call("look");
  await old.call("note", { text: "t" });
  await old.call("click", { target: 1 });
  await old.call("look");

  const single = await openRun();
  await single.move("look");
  await single.move("note", { text: "t" });
  await single.move("click", { target: 1 });

  const batched = await openRun();
  await batched.move("look");
  await batched.move("do", {
    moves: [
      { move: "note", text: "t" },
      { move: "click", target: 1 },
    ],
  });

  const want = old.clock.elapsedSeconds();
  assert.ok(want > 0);
  assert.equal(single.body.clock.elapsedSeconds(), want);
  assert.equal(batched.body.clock.elapsedSeconds(), want);
});

test("which moves change the screen, and which screens offer a choice that cannot be undone", () => {
  assert.equal(changesScreen("click"), true);
  assert.equal(changesScreen("note"), false);
  assert.equal(changesScreen("tabs", { action: "list" }), false);
  assert.equal(changesScreen("tabs", { action: "switch" }), true);
  assert.equal(destructiveChoice("Hi\n[4] Cerrar sesión").n, 4);
  for (const label of ["Cancel subscription", "Cancel plan", "Leave class", "Deactivate account", "Close account", "Remove account"])
    assert.ok(destructiveChoice(`[1] ${label}`), label);
  for (const label of ["Cancelar suscripción", "Cancelar plan", "Abandonar clase", "Desactivar cuenta", "Cerrar cuenta", "Dar de baja"])
    assert.ok(destructiveChoice(`[1] ${label}`), label);
  assert.equal(destructiveChoice("Hi\n[1] Eliminar cuenta").n, 1);
  assert.equal(destructiveChoice("Reset password mentioned in prose\n[1] Save"), null, "only a numbered control is a choice");
  assert.equal(destructiveChoice("[1] Remarkable offers"), null, "a word inside another word is not the word");
  assert.ok(planBatch({ moves: '[{"move":"note","text":"x"}]' }).moves, "a list as JSON text, the way a shell sends it");
});

test("only the control a move targets can stop it: a header Sign out never stops a scroll or another click", async () => {
  const { move, trace } = await openRun({ screen: HEADER_SCREEN });
  await move("look");
  const scrolled = await move("do", { moves: [{ move: "scroll", direction: "down" }] });
  assert.doesNotMatch(words(scrolled), /NOT made/);
  const signOut = await move("do", { moves: [{ move: "click", target: 1 }] });
  assert.match(words(signOut), /NOT made.*\[1\] Sign out/);
  const clicked = await move("do", { moves: [{ move: "click", target: 4 }] });
  assert.match(words(clicked), /Clicked 4\./);
  assert.deepEqual(
    trace().map((r) => r.tool),
    ["look", "scroll", "look", "click", "look"],
  );
  for (const label of ["Reset filters", "Forgot password? Reset it", "Remove filter: Price", "Restablecer contraseña"])
    assert.equal(destructiveChoice(`[1] ${label}`), null, label);
  for (const label of ["Reset my progress", "Remove all", "Reset account"]) assert.ok(destructiveChoice(`[1] ${label}`), label);
});

test("every note runs before the move whatever the list order, and a stopped move still has all its notes written", async () => {
  const { move, trace } = await openRun({ screen: DANGER_SCREEN });
  await move("look");
  const stopped = await move("do", {
    moves: [
      { move: "note", text: "before" },
      { move: "click", target: 2 },
      { move: "note", text: "after" },
    ],
  });
  assert.match(words(stopped), /NOT made/);
  assert.deepEqual(
    trace().flatMap((r) => (r.tool === "note" ? [r.args.text] : [])),
    ["before", "after"],
    "the note listed after the move is written too",
  );
  const ran = await openRun();
  await ran.move("look");
  await ran.move("do", {
    moves: [
      { move: "click", target: 1 },
      { move: "note", text: "late" },
    ],
  });
  assert.deepEqual(
    ran.trace().map((r) => r.tool),
    ["look", "note", "click", "look"],
    "the note comes first, so it describes the screen she made it on",
  );
});

test("a failing note stops the do before the move and says which note failed", async () => {
  const { move, trace, body } = await openRun();
  await move("look");
  const answer = await move("do", {
    moves: [
      { move: "note", text: "fine" },
      { move: "note", text: "BROKEN" },
      { move: "click", target: 1 },
    ],
  });
  assert.equal(answer.isError, true);
  assert.match(words(answer), /Note 2 of 2 failed, so your move \(click\) was NOT made/);
  assert.ok(!body.seen.includes("click"));
  assert.deepEqual(
    trace().map((r) => r.tool),
    ["look", "note", "note"],
  );
});

test("each trace row of a do is tagged as it is written, and rows other writers add are never touched", async () => {
  const run = await openRun();
  const hop = { at: "x", kind: "hop", url: "https://example.test/" };
  const call = run.body.call;
  run.body.call = async (name, args) => {
    const result = await call(name, args);
    // A hop row lands from the background in the middle of the batch.
    if (name === "note") fs.appendFileSync(run.tracePath, `${JSON.stringify(hop)}\n`);
    return result;
  };
  await run.move("look");
  await run.move("do", {
    moves: [
      { move: "note", text: "n" },
      { move: "click", target: 1 },
    ],
  });
  assert.deepEqual(
    run.trace().map((r) => [r.kind ?? r.tool, r.batch]),
    [
      ["look", undefined],
      ["note", 1],
      ["hop", undefined],
      ["click", 1],
      ["look", 1],
    ],
  );
});

test("a move that changed nothing answers with its own words, not a look and not Call look", async () => {
  const { move, trace } = await openRun();
  await move("look");
  const same = await move("do", { moves: [{ move: "scroll", direction: "down" }] });
  const said = words(same);
  assert.match(said, /^scroll:\nScrolled\./);
  assert.doesNotMatch(said, /Call look|\.jpg/);
  const changed = await move("click", { target: 1 });
  assert.match(words(changed), /\.jpg/);
  assert.deepEqual(
    trace().map((r) => r.tool),
    ["look", "scroll", "look", "click", "look"],
  );
});

// SUE round 7 (runs 20261004-234930-2d33, 20261004-234911-eb1f): six visitors on two products reported "the page moved
// under my thumb". Their brains made several moves in one turn from ONE look; the relay runs them one at a time, so the
// later ones reached her hands after the first had changed the screen and been answered with a new, renumbered look.
const SHEET = "Sell an item\n[1] Title\n[2] Price (USD) [tiny print you can barely make out]\n[3] Next [greyed out]";
const SHEET_WITH_KEYBOARD =
  "Your shop\n[1] Share your shop\n[2] Show me around\n[3] Dismiss\nSell an item\n[4] Title\n[5] Price (USD) [tiny print you can barely make out]\n[6] Next";

test("moves her brain made together from one look land on what she saw, though the first renumbered the screen", async () => {
  const { move, trace } = await openRun({ screen: SHEET, afterClick: SHEET_WITH_KEYBOARD });
  await move("look");
  const [title, price] = await Promise.all([move("click", { target: 1 }), move("click", { target: 2 })]);
  assert.match(words(title), /Clicked 1\./);
  assert.match(words(price), /Clicked 5\./, "her [2] Price (USD) is [5] now, and that is the box she pressed");
  assert.deepEqual(
    trace()
      .filter((r) => r.tool === "click")
      .map((r) => r.args.target),
    [1, 5],
  );
});

test("a do queued behind a move that renumbered the screen is carried over the same way", async () => {
  const { move, trace } = await openRun({ screen: SHEET, afterClick: SHEET_WITH_KEYBOARD });
  await move("look");
  await Promise.all([move("click", { target: 1 }), move("do", { moves: [{ move: "click", target: "[2]" }] })]);
  assert.deepEqual(
    trace()
      .filter((r) => r.tool === "click")
      .map((r) => r.args.target),
    [1, "[5]"],
  );
});

test("a control that is gone when the second move arrives is refused, and nothing is pressed", async () => {
  const { move, body } = await openRun({ screen: SHEET, afterClick: "Thanks\n[1] Done" });
  await move("look");
  const [, price] = await Promise.all([move("click", { target: 1 }), move("click", { target: 2 })]);
  assert.equal(price.isError, true);
  assert.match(words(price), /your \[2\] "Price \(USD\) \[tiny print[^"]*" is not on it any more, so nothing was pressed/);
  assert.equal(body.seen.filter((t) => t === "click").length, 1);
});

// Run 20261005-005606-a400 (round 8A), hotsauce-dre, jeweler-ines, baker-hana: the same burst, but the driver's shell
// calls reached the relay 0.1 to 0.6 s apart, each AFTER the one before had been answered with the keyboard-up look. The
// relay took that new look as "what she saw", so her [3] Price went to Dismiss and her [7] Description to Location.
test("moves that arrive in a burst, each after the one before was answered, still land on the look she made them from", async () => {
  let at = 1_000_000;
  const { move, trace } = await openRun({ screen: SHEET, afterClick: SHEET_WITH_KEYBOARD, now: () => at });
  await move("look");
  at += 5_000; // she reads the sheet, then writes three moves in one turn
  await move("click", { target: 1 });
  at += 300; // the next call of her turn: far too soon to have read the new look
  await move("click", { target: 2 });
  assert.deepEqual(
    trace()
      .filter((r) => r.tool === "click")
      .map((r) => r.args.target),
    [1, 5],
    "her [2] Price (USD) is [5] on the keyboard-up look",
  );
});

test("a move made after she had time to read the new look keeps its number: nothing is carried over", async () => {
  let at = 1_000_000;
  const { move, trace } = await openRun({ screen: SHEET, afterClick: SHEET_WITH_KEYBOARD, now: () => at });
  await move("look");
  at += 5_000;
  await move("click", { target: 1 });
  at += 6_000; // a new turn: she read the answer's look and picked from it
  await move("click", { target: 5 });
  assert.deepEqual(
    trace()
      .filter((r) => r.tool === "click")
      .map((r) => r.args.target),
    [1, 5],
  );
});

test("renumberStale matches a control by its own words, ignoring status tags, and refuses what it cannot tell apart", () => {
  const was = "[1] Title\n[2] Next [greyed out]\n[3] [an icon button]\n[4] [an icon button]";
  const now = "[1] Dismiss\n[2] Title\n[3] Next [tiny print you can barely make out]\n[4] [an icon button]\n[5] [an icon button]";
  assert.deepEqual(renumberStale(was, now, { target: 2 }).args, { target: 3 }, "tags come and go; the name stays");
  assert.deepEqual(
    renumberStale(was, now, { target: "[3]" }).args,
    { target: "[4]" },
    "the same place among look-alikes of the same count",
  );
  assert.deepEqual(renumberStale(was, now, { target: 4, onto: 1 }).args, { target: 5, onto: 2 });
  assert.deepEqual(renumberStale(was, now, { target: "15" }).args, { target: "15" }, "bare words may be a list choice");
  assert.deepEqual(renumberStale(was, now, { target: "Next" }).args, { target: "Next" }, "a name needs no number");
  assert.deepEqual(renumberStale(was, was, { target: 2 }).args, { target: 2 }, "the same screen changes nothing");
  assert.ok(renumberStale(was, "[1] Dismiss\n[2] [an icon button]", { target: 3 }).refusal, "three look-alikes became one");
  assert.ok(renumberStale(was, "[1] Dismiss", { target: 1 }).refusal, "gone");
});

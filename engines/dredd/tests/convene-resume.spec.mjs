/**
 * convene-resume.spec - durable convene: every result lands on disk the moment it is decided, so a process killed
 * mid-convene resumes without relaunching SUE (proposal P5, the MiroFish review, 2026-09-23).
 *
 * WHAT: `node --test dredd/tests/convene-resume.spec.mjs`. The pure parts (readConveneLog, resumePlan,
 * planFor) are tested on plain data, no I/O beyond a scratch convene.jsonl and no spawning. convene() itself is
 * exercised with cheap "now" instruments (a marker file each command appends to, so a rerun is caught) - never
 * with the real SUE instrument, whose launch/poll spawns real processes; the SUE branches (kept, re-attach
 * candidate, still-launching, never-launched) are proven either through resumePlan directly or through convene()
 * seeded with a row that short-circuits before the brain ladder is ever reached.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { roomLines } from "../lib/collect.mjs";
import {
  chatSueNote,
  convene,
  criticsFor,
  launchesSue,
  planFor,
  readConveneLog,
  readyCritics,
  resumePlan,
  SUE_CRITICS,
  SUE_LAUNCHING_WINDOW_MS,
  writeSueArgs,
} from "../lib/convene.mjs";
import { shellArg } from "../lib/docket.mjs";
import { rowFailed } from "../lib/hunt.mjs";
import { castForDocket, presueForDocket } from "../lib/visitors.mjs";
import "../../sue/tests/fixtures/people.mjs";

// Every scratch dir is removed after the file, whatever the outcome - a trailing rmSync only tidies a PASSING run.
const scratchDirs = [];
const scratchDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dredd-convene-resume-"));
  scratchDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
const node = shellArg(process.execPath);

// A tiny script, written once, that appends one "x" to the file named in argv[2] - the marker a "now" instrument's
// command leaves behind, so a rerun (rather than a replay from convene.jsonl) is caught by its counter growing.
const markerScript = path.join(scratchDir(), "mark.mjs");
writeFileSync(markerScript, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'x');\n");

// A script that fails loudly, standing in for "sue" in the tests that must prove convene() never reaches it.
const failScript = path.join(scratchDir(), "fail.mjs");
writeFileSync(failScript, "process.exit(7);\n");

function nowInstrument(id, counterFile) {
  return { id, mode: "now", phase: 1, run: `${node} ${shellArg(markerScript)} ${shellArg(counterFile)}` };
}

// -- SUE on the elevated tier: a chat convening starts her visitors on its own Sonnet 5.5 agents (Owner, 2026-10-05, replacing 2026-09-23) -------

// Stands in for `sue.mjs run`: records the brain it was handed, writes the run's chat-brains.json the way the cannon
// does once a chat-brain run is up, and prints the one JSON object the real door prints.
const fakeSue = path.join(scratchDir(), "fake-sue.mjs");
writeFileSync(
  fakeSue,
  [
    "import { writeFileSync } from 'node:fs';",
    "const [chatBrains, brainFile] = process.argv.slice(2);",
    "writeFileSync(brainFile, process.env.SUE_BRAIN || '');",
    "writeFileSync(chatBrains, '[]');",
    "console.log(JSON.stringify({ ok: true, runId: '20260923-101500-3e65', count: 5, chatBrains }));",
  ].join("\n"),
);

test("convene(): convened from a chat, SUE launches on the chat brain and tells the chat to start Sonnet agents", async () => {
  const dir = scratchDir();
  const chatBrains = path.join(dir, "chat-brains.json");
  const brainFile = path.join(dir, "brain.txt");
  const bench = {
    instruments: [{ id: "sue", mode: "now", phase: 3, run: `${node} ${shellArg(fakeSue)} ${shellArg(chatBrains)} ${shellArg(brainFile)}` }],
  };
  const docket = { ask: "does anyone understand the page", url: "http://localhost:9/x", convene: [{ id: "sue", phase: 3 }] };
  // CliMayte down, whatever this machine runs: a running AgentHydra would answer the default address and move the note.
  const climayteBefore = process.env.SUE_CLIMAYTE_URL;
  process.env.SUE_CLIMAYTE_URL = "http://127.0.0.1:9";
  try {
    const results = await convene({ root: dir, docket, bench, docketDir: dir, chat: true });
    const sue = results.find((r) => r.id === "sue");
    assert.equal(readFileSync(brainFile, "utf8"), "chat", "the run was started on the chat brain, not a pool");
    assert.equal(sue.brain, "chat");
    assert.match(sue.status, /^launched run 20260923-101500-3e65 \(chat brain: Sonnet 5\.5, the SUE tier/);
    assert.match(sue.note, /start one agent per Sue listed in .*chat-brains\.json, each on model "sonnet" \(Sonnet 5\.5/);
    assert.match(sue.note, /check_my_usage.*never handed to a cheaper model/);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")).count,
      5,
      "a chat sends the full count, not the paid three",
    );
    assert.deepEqual(
      readConveneLog(dir).map((r) => r.status.split(" ")[0]),
      ["launching", "launched"],
    );
  } finally {
    if (climayteBefore === undefined) delete process.env.SUE_CLIMAYTE_URL;
    else process.env.SUE_CLIMAYTE_URL = climayteBefore;
  }
});

test("convene(): a machine whose policy excludes the chat brain refuses SUE by name instead of launching", async () => {
  const dir = scratchDir();
  const policy = path.join(dir, "sue-brains.json");
  writeFileSync(policy, JSON.stringify({ brains: ["deepseek"], why: "test machine" }));
  const bench = { instruments: [{ id: "sue", mode: "now", phase: 3, run: `${node} ${shellArg(failScript)}` }] };
  const docket = { ask: "x", url: "http://localhost:9/x", convene: [{ id: "sue", phase: 3 }] };
  const before = process.env.SUE_BRAIN_POLICY;
  process.env.SUE_BRAIN_POLICY = policy;
  try {
    const results = await convene({ root: dir, docket, bench, docketDir: dir, chat: true });
    const sue = results.find((r) => r.id === "sue");
    assert.equal(sue.status, "refused");
    assert.match(sue.note, /runs Sue only on --brain deepseek.*never chat.*test machine/);
  } finally {
    if (before === undefined) delete process.env.SUE_BRAIN_POLICY;
    else process.env.SUE_BRAIN_POLICY = before;
  }
});

test("chatSueNote: names the tier, the list to read and the collect line, and survives a start that named no list", () => {
  const note = chatSueNote({ started: { count: 2 }, url: "https://x.test/", docketDir: "D" });
  assert.match(note, /^2 Sue\(s\) on https:\/\/x\.test\/ wait for this chat: .*the run's chat-brains\.json.*--collect --docket D$/);
});

// Owner, 2026-10-06: every Sue runs sealed on CliMayte; the chat's own brief-reading agents only when CliMayte is down.
test("chatSueNote: a run SUE sends itself asks for no agent; CliMayte ready hands the run over; CliMayte down is the old way", () => {
  const base = { url: "https://x.test/", docketDir: "D" };
  const sent = chatSueNote({ ...base, started: { count: 1, runId: "R", chatBrains: "/r/chat-brains.json", dispatch: "climayte" } });
  assert.match(sent, /SUE sends each one to CliMayte itself, as ONE sealed task/);
  assert.match(sent, /starts NO agent for them \(climayte_status \{ group: "sue-R" \}/);
  assert.match(sent, /--collect --docket D$/);
  const ready = chatSueNote({ ...base, started: { count: 2, runId: "R" }, climayte: { ready: true } });
  assert.match(
    ready,
    /hand them to CliMayte, each as ONE sealed task .*never an agent of this chat's own: node sue\/dispatch\.mjs R /,
  );
  const down = chatSueNote({
    ...base,
    started: { count: 2, runId: "R" },
    climayte: { ready: false, why: "AgentHydra did not answer at X" },
  });
  assert.match(down, /^CliMayte is unavailable \(AgentHydra did not answer at X\), so the old way: 2 Sue\(s\) on https:\/\/x\.test\/ wait/);
  assert.doesNotMatch(down, /dispatch\.mjs/);
  const room = chatSueNote({ ...base, started: { count: 4, runId: "R" }, focusGroup: true, climayte: { ready: false, why: "W" } });
  assert.match(room, /^CliMayte is unavailable \(W\), so the old way: A focus group of 4 .*ALL in one message/);
});

test("writeSueArgs: carries dispatch only when asked, so SUE sends the Sues herself", () => {
  const dir = scratchDir();
  const docket = { ask: "is this page clear", url: "https://x.test/" };
  writeSueArgs(dir, { id: "sue" }, docket, { dispatch: "climayte" });
  assert.equal(JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")).dispatch, "climayte");
  writeSueArgs(dir, { id: "sue" }, docket);
  assert.equal("dispatch" in JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")), false);
});

// -- SUE's focus group: the same door as SUE (its run line reads the args file), never a bare "now" run -------------
// It ran bare until 2026-09-23 and its one convening died on an args file only SUE's branch ever wrote.

// Stands in for `sue.mjs focus_group`: dies unless the args file exists (the defect), then starts like the real door.
const fakeGroup = path.join(scratchDir(), "fake-group.mjs");
writeFileSync(
  fakeGroup,
  [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const [chatBrains, brainFile, argsFile] = process.argv.slice(2);",
    "const args = JSON.parse(readFileSync(argsFile, 'utf8'));",
    "writeFileSync(brainFile, process.env.SUE_BRAIN || '');",
    "writeFileSync(chatBrains, '[]');",
    "console.log(JSON.stringify({ ok: true, runId: '20260923-190000-f0c5', count: args.count ?? 4, chatBrains }));",
  ].join("\n"),
);
const groupBench = (dir) => ({
  instruments: [
    {
      id: "focus-group",
      mode: "now",
      phase: 3,
      run: `${node} ${shellArg(fakeGroup)} ${shellArg(path.join(dir, "chat-brains.json"))} ${shellArg(path.join(dir, "brain.txt"))} {sueArgsFile}`,
    },
  ],
});

test("launchesSue: an instrument whose run line reads the args file is SUE's door; nothing else is", () => {
  assert.equal(launchesSue({ id: "sue", run: "node sue/sue.mjs run --json-file {sueArgsFile}" }), true);
  assert.equal(launchesSue({ id: "focus-group", run: "node sue/sue.mjs focus_group --json-file {sueArgsFile}" }), true);
  assert.equal(launchesSue({ id: "code-gate", run: "node {connections}/.arkitect/runners/code-gate.mjs {paths}" }), false);
  assert.equal(launchesSue({ id: "x" }), false);
});

test("convene(): from a chat, the focus group gets its own args file, the chat brain and the room's own wording", async () => {
  const dir = scratchDir();
  const before = process.env.DREDD_SUE_COUNT;
  const climayteBefore = process.env.SUE_CLIMAYTE_URL;
  delete process.env.DREDD_SUE_COUNT;
  // CliMayte down, whatever this machine runs: the probe meets a closed port, so the room gets the old way's wording.
  process.env.SUE_CLIMAYTE_URL = "http://127.0.0.1:9";
  try {
    const docket = { ask: "what feels off here", url: "http://localhost:9/x", convene: [{ id: "focus-group", phase: 3 }] };
    const results = await convene({ root: dir, docket, bench: groupBench(dir), docketDir: dir, chat: true });
    const group = results.find((r) => r.id === "focus-group");
    assert.equal(readFileSync(path.join(dir, "brain.txt"), "utf8"), "chat", "the room thinks on the chat's agents");
    assert.match(group.status, /^launched run 20260923-190000-f0c5 \(chat brain: Sonnet 5\.5/);
    assert.equal(group.runId, "20260923-190000-f0c5", "the runId is recorded, so --collect can read the room's verdict");
    assert.match(
      group.note,
      /^CliMayte is unavailable \(AgentHydra did not answer at http:\/\/127\.0\.0\.1:9\), so the old way: A focus group of 4 on http:\/\/localhost:9\/x waits for this chat: .*the moderator included, ALL in one message/,
    );
    const args = JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8"));
    assert.equal(args.url, "http://localhost:9/x");
    assert.equal("count" in args, false, "no count: sue.mjs seats the room's own default, never SUE's five");
    assert.deepEqual(
      readConveneLog(dir).map((r) => r.status.split(" ")[0]),
      ["launched"],
      "no launching row: only SUE is re-attached on a resume",
    );
  } finally {
    if (before !== undefined) process.env.DREDD_SUE_COUNT = before;
    if (climayteBefore === undefined) delete process.env.SUE_CLIMAYTE_URL;
    else process.env.SUE_CLIMAYTE_URL = climayteBefore;
  }
});

test("writeSueArgs: DREDD_SUE_COUNT sizes a focus group when set; SUE keeps her chat and paid counts", () => {
  const dir = scratchDir();
  const docket = { ask: "a".repeat(300), url: "https://x.test/" };
  const before = process.env.DREDD_SUE_COUNT;
  try {
    process.env.DREDD_SUE_COUNT = "6";
    writeSueArgs(dir, { id: "focus-group" }, docket);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")).count, 6);
    delete process.env.DREDD_SUE_COUNT;
    writeSueArgs(dir, { id: "sue" }, docket);
    const sue = JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8"));
    assert.equal(sue.count, 5);
    assert.equal(sue.intent, docket.ask, "an ask of 300 characters goes whole (intentOf's ceiling)");
    assert.equal("cast" in sue, false, "no cast on the docket: SUE picks as she always has");
    // The docket's cast (lib/visitors.mjs) is who SUE sends.
    const visitor = { id: "party-planner-lena", extends: "elaine", voice: "You are Lena, 41, a party planner.", errands: ["x"] };
    writeSueArgs(dir, { id: "sue" }, { ...docket, cast: { visitors: [visitor] } });
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")).cast, [visitor]);
    writeSueArgs(dir, { id: "sue" }, docket, { paid: true });
    assert.equal(JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")).count, 3);
  } finally {
    if (before === undefined) delete process.env.DREDD_SUE_COUNT;
    else process.env.DREDD_SUE_COUNT = before;
  }
});

test("a pre-sued docket sends its picks by name, the onboarded riding inline, and saves them through the hearing's MCP", async () => {
  // the Chair, 2026-10-05: "Sue/Dredd need a Jev. Pre-sue ... and if not, onboard (create) the ones relevant."
  const dir = scratchDir();
  const before = process.env.DREDD_SUE_COUNT;
  delete process.env.DREDD_SUE_COUNT;
  try {
    const rigger = {
      id: "rigger-luis",
      extends: "bob",
      voice: "You are Luis, 52, a rigger.",
      errands: ["x"],
      for: ["oplink.example.test"],
    };
    const docket = { ask: "review the crane signalling tool for the crew", url: "https://oplink.example.test/", convene: [{ id: "sue" }] };
    const saves = [];
    const mcp = {
      api: async (plane, tool, body) => (
        saves.push([plane, tool, body.personas.map((p) => p.doc.id)]),
        { ok: true, body: { personas: [], refused: [] } }
      ),
    };
    const presue = async ({ intent }) => ({
      said: `fits ${intent}`,
      page: { title: "OperatorLink" },
      judge: "jev",
      asked: 30,
      need: 3,
      fit: [],
      closest: [],
      onboarded: [rigger],
      send: ["machine-operator", "crane-op", "rigger-luis"],
    });
    docket.cast = await presueForDocket(docket, { mcp, presue });
    assert.deepEqual(saves, [["boardroom", "boardroom_personas_sue_save", ["rigger-luis"]]]);
    writeSueArgs(dir, { id: "sue" }, docket);
    const args = JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8"));
    assert.deepEqual(args.personas, ["machine-operator", "crane-op", "rigger-luis"]);
    assert.deepEqual(args.cast, [rigger]);
  } finally {
    if (before !== undefined) process.env.DREDD_SUE_COUNT = before;
  }
});

test("a pre-sue that sends nobody is no cast: the docket hears why and casts from the ask instead", async () => {
  // Review of 2026-10-05: an empty pick became the docket's cast, so SUE fell back to the workspace's saved people.
  const saves = [];
  const mcp = { api: async (...call) => (saves.push(call), { ok: true, body: { personas: [], refused: [] } }) };
  const presue = async () => ({
    said: "Pre-sue (floor): 0 of 20 people fit oplink.example.test; nobody onboarded (no brain).",
    judge: "floor",
    asked: 20,
    need: 3,
    fit: [],
    closest: [],
    onboarded: [],
    send: [],
  });
  const docket = { ask: "review the crane signalling tool for the crew", url: "https://oplink.example.test/", convene: [{ id: "sue" }] };
  const pre = await presueForDocket(docket, { mcp, presue });
  assert.match(pre.error ?? "", /sent nobody.*0 of 20 people fit/);
  assert.deepEqual(saves, [], "nothing to save");
});

test("a kids ask sends SUE's own children as themselves beside the critics, never a kid on an adult body", async () => {
  // Docket 20260929-031805-044a: Lift, a learning app for 9 to 11 year olds, was cast "Fifth Grader Maya, 19".
  const dir = scratchDir();
  const before = process.env.DREDD_SUE_COUNT;
  delete process.env.DREDD_SUE_COUNT;
  try {
    const docket = {
      ask: "Kids aged 9 to 11 get bored in a lesson and quit partway",
      url: "https://lift.example.org/student/",
      convene: [{ id: "sue" }],
    };
    docket.cast = await castForDocket(docket);
    writeSueArgs(dir, { id: "sue" }, docket);
    const args = JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8"));
    assert.deepEqual(args.personas, ["child", "kid-kai", "retention-doctor", "game-designer"]);
    assert.equal("cast" in args, false, "no adult body wears a kid's errand");
  } finally {
    if (before !== undefined) process.env.DREDD_SUE_COUNT = before;
  }
});

test("writeSueArgs: an ask about drop-off or boredom sends the two critics beside the cast, or beside TikTok Sue", () => {
  const dir = scratchDir();
  const before = process.env.DREDD_SUE_COUNT;
  delete process.env.DREDD_SUE_COUNT;
  const read = () => JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8"));
  try {
    const docket = { ask: "people drop off on the pricing page and I think it is boring", url: "https://x.test/pricing" };
    writeSueArgs(dir, { id: "sue" }, docket);
    // The pricing page is where people decide to pay, so this ask is a buying ask too (2026-09-30): the buying critic joins.
    assert.deepEqual(
      read().personas,
      ["tiktok", "retention-doctor", "game-designer", "ads-readiness"],
      "no cast: TikTok Sue is the visitor they watch",
    );
    assert.equal(read().count, 5, "the chat's count still holds when it is larger");
    const visitor = { id: "salon-sofia", extends: "elaine", voice: "You are Sofia, 38, a salon owner.", errands: ["x"] };
    writeSueArgs(dir, { id: "sue" }, { ...docket, cast: { visitors: [visitor] } });
    assert.deepEqual(read().personas, ["salon-sofia", "retention-doctor", "game-designer", "ads-readiness"]);
    assert.deepEqual(read().cast, [visitor], "the cast still rides, so a named cast id resolves");
    writeSueArgs(dir, { id: "sue" }, { ask: "the signup button is the wrong colour", url: "https://x.test/" });
    assert.equal("personas" in read(), false, "an ask with no attention in it sends SUE as she always has");
    writeSueArgs(dir, { id: "focus-group" }, docket);
    assert.equal("personas" in read(), false, "a focus group seats visitors, never the critics");
    assert.deepEqual(criticsFor("where do players lose interest in the first session"), ["retention-doctor", "game-designer"]);
    assert.deepEqual(criticsFor("fix the webhooks retry"), [], "a word that merely contains hook is not an attention ask");
    // Owner, 2026-09-30: "what's left before I can start running ads ... would they stay? would they leave? would they
    // purchase?" sent no critic: none of its words is an attention word. A buying ask sends the buying critic and the
    // attention critic beside her; one that is both sends all three once.
    const ads = "what's left before I can start running ads, if a human ran through this would they stay, leave or purchase";
    assert.deepEqual(criticsFor(ads), ["ads-readiness", "retention-doctor"]);
    assert.deepEqual(criticsFor("people drop off before checkout"), ["retention-doctor", "game-designer", "ads-readiness"]);
    assert.deepEqual(criticsFor("the signup button is the wrong colour"), [], "a sign-up screen alone is not a buying ask");
  } finally {
    if (before !== undefined) process.env.DREDD_SUE_COUNT = before;
  }
});

test("writeSueArgs: a critic the workspace does not hold whole in Connections (her person and a mind) stays home and is named", () => {
  const dir = scratchDir();
  // What the hearing read from the Sue list (convene's syncPeople): the critics there with a mind of their own.
  const people = { fetched: true, fromConnections: 23, critics: ["retention-doctor"] };
  assert.deepEqual(readyCritics(people, SUE_CRITICS), { ready: ["retention-doctor"], skipped: ["game-designer"] });
  const docket = { ask: "people drop off on the pricing page", url: "https://x.test/pricing", people };
  writeSueArgs(dir, { id: "sue" }, docket);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")).personas, ["tiktok", "retention-doctor"]);
  assert.deepEqual(docket.criticsSkipped, ["game-designer", "ads-readiness"], "each one left home is on the docket");
  const unread = { ...docket, people: { fetched: false, why: "the Boardroom could not be reached" }, criticsSkipped: undefined };
  writeSueArgs(dir, { id: "sue" }, unread);
  assert.equal(
    "personas" in JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8")),
    false,
    "no critic known whole: SUE goes as she always has",
  );
  assert.deepEqual(unread.criticsSkipped, [...SUE_CRITICS, "ads-readiness"]);
});

test("convene(): unattended, the focus group sits out by design (no key pool unasked) and needs a page", async () => {
  const dir = scratchDir();
  const pin = process.env.DREDD_SUE_BRAINS;
  const brain = process.env.SUE_BRAIN;
  delete process.env.DREDD_SUE_BRAINS;
  delete process.env.SUE_BRAIN;
  try {
    const docket = { ask: "what feels off here", url: "http://localhost:9/x", convene: [{ id: "focus-group", phase: 3 }] };
    const [group] = (await convene({ root: dir, docket, bench: groupBench(dir), docketDir: dir })).filter((r) => r.id === "focus-group");
    assert.equal(group.status, "refused");
    assert.match(group.note, /^The focus group thinks in the chat that runs Dredd, never on a key pool unasked .* so it sits this one out/);
    assert.equal(rowFailed(group), false, "a by-design sit-out is never a hunt item");
    assert.equal(existsSync(path.join(dir, "brain.txt")), false, "nothing launched");
    const bare = scratchDir();
    const [skipped] = await convene({ root: bare, docket: { ...docket, url: null }, bench: groupBench(bare), docketDir: bare });
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.note, /pass --url <page> and the focus group sits over it/);
  } finally {
    if (pin !== undefined) process.env.DREDD_SUE_BRAINS = pin;
    if (brain !== undefined) process.env.SUE_BRAIN = brain;
  }
});

test("roomLines: what the room agreed leads the focus group's log; a run with no room adds nothing", () => {
  assert.deepEqual(roomLines(null), []);
  const lines = roomLines({
    size: 4,
    phase: "closed",
    verdict: {
      problem: "nobody could tell what the page sells",
      decidedBy: "vote",
      agreedBy: ["Ann", "Bo", "Cy"],
      against: ["Di"],
      size: 4,
      quotes: [{ name: "Ann", text: "I read it twice and still did not know" }],
      lastProblem: "the button was grey",
      lastProblemStillThere: "no",
    },
    onTheirOwn: [{ name: "Di", said: "the price was hidden" }],
  });
  assert.equal(lines[0], "The room agreed (by vote, 3 of 4): nobody could tell what the page sells");
  assert.ok(lines.includes("against: Di"));
  assert.ok(lines.includes("the last focus group's problem: the button was grey - still there: no"));
  assert.ok(lines.includes("- Ann: I read it twice and still did not know"));
  assert.ok(lines.includes("- on her own, Di: the price was hidden"));
  assert.deepEqual(roomLines({ phase: "table", lines: 9, verdict: null }), ["The room never agreed (table, 9 line(s) said)"]);
});

// -- readConveneLog ----------------------------------------------------------------------------------------------

test("readConveneLog: no file reads as no rows; one damaged line never loses the rows around it", () => {
  const dir = scratchDir();
  assert.deepEqual(readConveneLog(dir), []);
  writeFileSync(path.join(dir, "convene.jsonl"), '{"id":"a","status":"ok"}\nnot json\n{"id":"b","status":"ok"}\n');
  assert.deepEqual(
    readConveneLog(dir).map((r) => r.id),
    ["a", "b"],
  );
});

// -- resumePlan (pure) -------------------------------------------------------------------------------------------

test("resumePlan: nothing recorded runs everything; a terminal row is kept and dropped from toRun", () => {
  const instruments = [{ id: "a" }, { id: "b" }, { id: "sue" }];
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  assert.deepEqual(resumePlan({ instruments, rows: [], now }), {
    kept: [],
    toRun: ["a", "b", "sue"],
    reattach: {},
    stillLaunching: {},
    sueReattach: null,
    sueStillLaunching: null,
    retried: [],
    final: [],
  });
  const rowA = { id: "a", status: "ran, exit 0" };
  const rowB = { id: "b", status: "skipped" };
  const plan = resumePlan({ instruments, rows: [rowA, rowB], now });
  assert.deepEqual(plan.kept, [rowA, rowB]);
  assert.deepEqual(plan.toRun, ["sue"]);
});

test("resumePlan: a later row for the same id supersedes an earlier one", () => {
  const plan = resumePlan({
    instruments: [{ id: "a" }],
    rows: [
      { id: "a", status: "first" },
      { id: "a", status: "second" },
    ],
  });
  assert.deepEqual(plan.kept, [{ id: "a", status: "second" }]);
  assert.deepEqual(plan.toRun, []);
});

test("resumePlan: a launching SUE row branches on whether its log named a runId, and on the launch window", () => {
  const instruments = [{ id: "sue" }];
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  const launching = { id: "sue", status: "launching", brain: "deepseek", log: "sue.log", at: new Date(now - 5_000).toISOString() };

  // the log already names a run: re-attach, never a second launch.
  const reattach = resumePlan({ instruments, rows: [launching], sueLogRunId: "abc123", now });
  assert.deepEqual(reattach.sueReattach, { runId: "abc123", brain: "deepseek", log: "sue.log" });
  assert.equal(reattach.sueStillLaunching, null);
  assert.deepEqual(reattach.toRun, []);

  // no runId yet, but still inside the window: neither re-attach (nothing to poll) nor relaunch (it may still land).
  const waiting = resumePlan({ instruments, rows: [launching], sueLogRunId: null, now });
  assert.deepEqual(waiting.sueStillLaunching, launching);
  assert.equal(waiting.sueReattach, null);
  assert.deepEqual(waiting.toRun, []);

  // no runId, and the window has passed: it can never block forever, so it counts as never launched.
  const stale = { ...launching, at: new Date(now - SUE_LAUNCHING_WINDOW_MS - 1_000).toISOString() };
  const gaveUp = resumePlan({ instruments, rows: [stale], sueLogRunId: null, now });
  assert.equal(gaveUp.sueStillLaunching, null);
  assert.equal(gaveUp.sueReattach, null);
  assert.deepEqual(gaveUp.toRun, ["sue"]);

  // a TERMINAL sue row (not "launching") is kept like any other instrument - it never re-enters the ladder logic.
  const done = { id: "sue", status: "launched run X (deepseek brain)" };
  const kept = resumePlan({ instruments, rows: [done], now });
  assert.deepEqual(kept.kept, [done]);
  assert.deepEqual(kept.toRun, []);
  assert.equal(kept.sueReattach, null);
  assert.equal(kept.sueStillLaunching, null);
});

// -- planFor ----------------------------------------------------------------------------------------------------

test("planFor: a legacy docket.results (no convene.jsonl yet) counts as kept, and jsonl outranks it once it exists", () => {
  const dir = scratchDir();
  const docket = { convene: [{ id: "a" }, { id: "sue" }], results: [{ id: "a", status: "old, from before convene.jsonl existed" }] };
  let plan = planFor(docket, dir);
  assert.deepEqual(
    plan.kept.map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(plan.toRun, ["sue"]);
  writeFileSync(path.join(dir, "convene.jsonl"), `${JSON.stringify({ id: "a", status: "re-run, exit 0" })}\n`);
  plan = planFor(docket, dir);
  assert.deepEqual(
    plan.kept.map((r) => r.status),
    ["re-run, exit 0"],
  );
});

// -- convene() end to end, with cheap "now" instruments (nothing spawned that costs anything) ---------------------

test("convene(): writes one convene.jsonl row per result, as it lands", async () => {
  const dir = scratchDir();
  const counterA = path.join(dir, "a.count");
  const counterB = path.join(dir, "b.count");
  const bench = { instruments: [nowInstrument("a", counterA), nowInstrument("b", counterB)] };
  const docket = {
    convene: [
      { id: "a", phase: 1 },
      { id: "b", phase: 1 },
    ],
    url: null,
    ask: "test",
    domain: "x",
    surfaces: [],
    paths: [],
  };
  const results = await convene({ root: dir, docket, bench, docketDir: dir });
  assert.deepEqual(
    results.map((r) => r.id),
    ["a", "b"],
  );
  assert.match(results[0].status, /^ran, exit 0/);
  assert.deepEqual(
    readConveneLog(dir).map((r) => r.id),
    ["a", "b"],
  );
  assert.equal(readFileSync(counterA, "utf8"), "x");
  assert.equal(readFileSync(counterB, "utf8"), "x");
});

test("convene(): a second call on the same docket keeps what already landed and never runs it again", async () => {
  const dir = scratchDir();
  const counterA = path.join(dir, "a.count");
  const counterB = path.join(dir, "b.count");
  const bench = { instruments: [nowInstrument("a", counterA), nowInstrument("b", counterB)] };
  const docket = {
    convene: [
      { id: "a", phase: 1 },
      { id: "b", phase: 1 },
    ],
    url: null,
    ask: "test",
    domain: "x",
    surfaces: [],
    paths: [],
  };
  await convene({ root: dir, docket, bench, docketDir: dir });
  assert.equal(readFileSync(counterA, "utf8"), "x");
  const results = await convene({ root: dir, docket, bench, docketDir: dir });
  // never re-run: the marker files hold exactly one "x", not two.
  assert.equal(readFileSync(counterA, "utf8"), "x");
  assert.equal(readFileSync(counterB, "utf8"), "x");
  assert.deepEqual(
    results.map((r) => r.id),
    ["convene", "a", "b"],
  );
  assert.equal(results[0].status, "resumed");
  assert.match(results[0].note, /convene resumed: 2 kept, 0 launched/);
});

test("convene(): resumed after a crash mid-loop reruns only the instrument that never landed a row", async () => {
  const dir = scratchDir();
  const counterA = path.join(dir, "a.count");
  const counterB = path.join(dir, "b.count");
  const bench = { instruments: [nowInstrument("a", counterA), nowInstrument("b", counterB)] };
  const docket = {
    convene: [
      { id: "a", phase: 1 },
      { id: "b", phase: 1 },
    ],
    url: null,
    ask: "test",
    domain: "x",
    surfaces: [],
    paths: [],
  };
  // simulate a process that recorded "a" and then died before "b" ever ran.
  writeFileSync(path.join(dir, "convene.jsonl"), `${JSON.stringify({ id: "a", status: "ran, exit 0 (seeded)", note: "" })}\n`);
  const results = await convene({ root: dir, docket, bench, docketDir: dir });
  assert.equal(existsSync(counterA), false, "a was kept from the seeded row - its command must not have run");
  assert.equal(readFileSync(counterB, "utf8"), "x", "b never landed a row, so it ran this time");
  assert.deepEqual(
    results.map((r) => r.id),
    ["convene", "a", "b"],
  );
  assert.match(results[0].note, /convene resumed: 1 kept, 1 launched/);
  assert.equal(results[1].status, "ran, exit 0 (seeded)");
});

test("convene(): a terminal SUE row in convene.jsonl is replayed verbatim, never re-entering the brain ladder", async () => {
  const dir = scratchDir();
  const seeded = {
    id: "sue",
    status: "launched run FAKE123 (deepseek brain)",
    note: "3 Sue(s) on https://example.com/; collect: node dredd/dredd.mjs --collect --docket " + dir,
    log: path.join(dir, "sue.log"),
    runId: "FAKE123",
    brain: "deepseek",
  };
  writeFileSync(path.join(dir, "convene.jsonl"), `${JSON.stringify(seeded)}\n`);
  // A "sue" whose run would fail loudly if convene() ever reached it - proving the kept row short-circuited first.
  const bench = { instruments: [{ id: "sue", mode: "now", phase: 3, run: `${node} ${shellArg(failScript)}` }] };
  const docket = { convene: [{ id: "sue", phase: 3 }], url: "https://example.com/", ask: "test", domain: "flow", surfaces: [], paths: [] };
  const results = await convene({ root: dir, docket, bench, docketDir: dir });
  assert.deepEqual(
    results.find((r) => r.id === "sue"),
    seeded,
  );
  assert.match(results[0].note, /convene resumed: 1 kept, 0 launched/);
});

test("convene(): a SUE row still inside its launch window is neither re-attached nor relaunched, and its durable marker is untouched", async () => {
  const dir = scratchDir();
  const seeded = { id: "sue", status: "launching", brain: "deepseek", log: path.join(dir, "sue.log"), at: new Date().toISOString() };
  writeFileSync(path.join(dir, "convene.jsonl"), `${JSON.stringify(seeded)}\n`);
  const bench = { instruments: [{ id: "sue", mode: "now", phase: 3, run: `${node} ${shellArg(failScript)}` }] };
  const docket = { convene: [{ id: "sue", phase: 3 }], url: "https://example.com/", ask: "test", domain: "flow", surfaces: [], paths: [] };
  const results = await convene({ root: dir, docket, bench, docketDir: dir });
  const row = results.find((r) => r.id === "sue");
  assert.match(row.status, /still starting/);
  assert.match(row.note, /has not yet written a runId/);
  // the row is informational only - the ORIGINAL "launching" marker must still be the last (and only) sue line, so
  // a later resume reads it fresh instead of reading today's "still starting" as a kept, terminal answer.
  assert.deepEqual(readConveneLog(dir), [seeded]);
});

test("an instrument refused by a backend outage is sent again on resume; a refusal by design stays final", () => {
  // Board mail #7016 (2026-10-02): the credit check said "try again in a moment" and the personas list a
  // connection-slots error, and the resume minutes later kept SUE, the focus group and the room as answers.
  const plan = resumePlan({
    instruments: [{ id: "page-pulse" }, { id: "sue" }, { id: "focus-group" }, { id: "boardroom" }, { id: "flow-walk" }],
    rows: [
      { id: "page-pulse", status: "ran, exit 0" },
      { id: "sue", status: "refused", note: "the credit check answered: try again in a moment" },
      { id: "focus-group", status: "refused", note: "personas: remaining connection slots are reserved" },
      { id: "boardroom", status: "ran, exit 1", note: "HTTP 503 from the board" },
      { id: "flow-walk", status: "refused", note: "SUE thinks in the chat that runs Dredd, so she sits this one out" },
    ],
  });
  assert.deepEqual(plan.retried, ["sue", "focus-group", "boardroom"]);
  assert.deepEqual(plan.toRun, ["sue", "focus-group", "boardroom"]);
  assert.deepEqual(
    plan.kept.map((r) => r.id),
    ["page-pulse", "flow-walk"],
  );
  assert.deepEqual(
    plan.final.map((r) => r.id),
    ["flow-walk"],
    "a refusal that names no outage is final, and the resume says so",
  );
});

test("writeSueArgs: DREDD_SUE_EXPECT or the docket's expect reaches the spec; neither leaves no expect key", () => {
  const dir = scratchDir();
  const docket = { ask: "a".repeat(100), url: "https://x.test/" };
  const before = process.env.DREDD_SUE_EXPECT;
  const argsOf = () => JSON.parse(readFileSync(path.join(dir, "sue-args.json"), "utf8"));
  try {
    delete process.env.DREDD_SUE_EXPECT;
    writeSueArgs(dir, { id: "sue" }, docket);
    assert.equal("expect" in argsOf(), false, "an expect is never invented from the ask");
    writeSueArgs(dir, { id: "sue" }, { ...docket, expect: "a lesson on using AI safely" });
    assert.equal(argsOf().expect, "a lesson on using AI safely");
    process.env.DREDD_SUE_EXPECT = " a math quiz ";
    writeSueArgs(dir, { id: "sue" }, { ...docket, expect: "a lesson on using AI safely" });
    assert.equal(argsOf().expect, "a math quiz", "the env wins, trimmed");
    writeSueArgs(dir, { id: "focus-group" }, docket);
    assert.equal(argsOf().expect, "a math quiz", "a focus group carries it too");
  } finally {
    if (before === undefined) delete process.env.DREDD_SUE_EXPECT;
    else process.env.DREDD_SUE_EXPECT = before;
  }
});

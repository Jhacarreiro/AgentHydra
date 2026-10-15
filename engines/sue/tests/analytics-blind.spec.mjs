// blind view: a run's ARGUS timelines with no Sue, persona, intent or finding in them. Recorded fixtures only, no network.
// Run: node --test sue/tests/analytics-blind.spec.mjs

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { asciiJson, blindView } from "../analytics-view.mjs";
import { parseCli } from "../sue.mjs";

const MARKERS = ["MARKER_FINDING_maya", "MARKER_PERSONA_jordan", "MARKER_INTENT_alex", "sue-85"];
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-"));
  roots.push(dir);
  const sue = (id, trace, summary, interview, findings = []) => {
    const d = path.join(dir, id);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "trace.jsonl"), jsonl(trace));
    fs.writeFileSync(path.join(d, "summary.json"), JSON.stringify(summary));
    fs.writeFileSync(path.join(d, "interview.json"), JSON.stringify(interview));
    fs.writeFileSync(path.join(d, "findings.jsonl"), jsonl(findings));
  };
  sue(
    "sue-1-ann",
    [
      { kind: "hop", url: "https://ticket.test/", argus_sid: "S-ann" },
      { kind: "hop", url: "https://ticket.test/premium", argus_sid: "S-ann" },
      { kind: "end", argus_sid: "S-stale" },
    ],
    { persona: "MARKER_PERSONA_jordan", intent: "MARKER_INTENT_alex buy a ticket", argusSids: ["S-ann"] },
    { mostConfusing: "MARKER_FINDING_maya the Yearly toggle", starsOutOfFive: 2 },
    [{ source: "sue-85", kind: "complaint", text: "MARKER_FINDING_maya could not tell what the Yearly button did" }],
  );
  sue(
    "sue-2-bo",
    [{ kind: "hop", url: "https://ticket.test/", argus_sid: "S-bo" }],
    { persona: "MARKER_PERSONA_jordan", intent: "MARKER_INTENT_alex", argusSids: [] },
    { starsOutOfFive: 4 },
  );
  return dir;
}

const T0 = Date.parse("2026-10-11T14:00:00.000Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const raw = (over) => ({
  occurred_at: at(0),
  page_path: "/",
  device_type: "desktop",
  browser: "Chrome",
  os: "Windows",
  country: "GB",
  referrer: "https://news.test/story",
  anonymous_id: "anon-1",
  email: "MARKER_EMAIL@example.test",
  sub: "MARKER_SUB",
  props: { tracking_policy: "POLICY_BLOB", tracking_purpose: "PURPOSE_BLOB" },
  ...over,
});
const EVENTS = [
  raw({ occurred_at: at(-30), session_id: "S-bo", event_type: "pageview", event_name: "page_view" }),
  raw({
    session_id: "S-ann",
    event_type: "pageview",
    event_name: "page_view",
    props: { experiment_pricing: "b", tracking_policy: "POLICY_BLOB" },
  }),
  raw({ occurred_at: at(2.5), session_id: "S-ann", event_type: "scroll", event_name: "scroll", props: { depth: 75 } }),
  raw({
    occurred_at: at(4),
    session_id: "S-ann",
    page_path: "/premium",
    event_type: "click",
    event_name: "click",
    element_text: "Yearly price",
    element_href: "https://ticket.test/premium#yearly",
  }),
  raw({
    occurred_at: at(6),
    session_id: "S-ann",
    page_path: "/premium",
    event_type: "custom",
    event_name: "dead_click",
    element_text: "Yearly price",
  }),
  raw({
    occurred_at: at(9),
    session_id: "S-ann",
    event_type: "user_engagement",
    event_name: "user_engagement",
    props: { engagement_time_ms: 42000 },
  }),
  raw({
    occurred_at: at(10),
    session_id: "S-ann",
    event_type: "user_engagement",
    event_name: "user_engagement",
    props: { engagement_time_ms: 0 },
  }),
  raw({ occurred_at: at(11), session_id: "S-ann", event_type: "error", event_name: "js_error", props: { message: "boom" } }),
  raw({ session_id: "S-someone-else" }),
  raw({ session_id: "S-stale" }),
];

test("the blind view holds no Sue, persona, intent or finding, and no session or person identifier", async () => {
  const dir = makeRun();
  const view = await blindView({ runId: "r1", dir, events: EVENTS, site: "site-1", host: "ticket.test", write: false });
  const out = JSON.stringify(view);
  for (const marker of MARKERS) assert.ok(!out.includes(marker), `leaked ${marker}`);
  for (const banned of [
    "sue-1-ann",
    "sue-2-bo",
    "persona",
    "intent",
    "sueId",
    "sue_id",
    "sue_run",
    "S-ann",
    "S-bo",
    "S-stale",
    "S-someone-else",
    "MARKER_EMAIL",
    "MARKER_SUB",
    "anon-1",
    "POLICY_BLOB",
    "PURPOSE_BLOB",
    "tracking_policy",
    "tracking_purpose",
    "findings",
    "themes",
    "agreement",
    dir,
  ]) {
    assert.ok(!out.includes(banned), `leaked ${banned}`);
  }
  assert.equal(view.visitors.length, 2);
  assert.equal(view.visitors[0].visitor, "Visitor 1");
  assert.equal(view.visitors[1].visitor, "Visitor 2");
});

test("visitors are numbered in session start order, and only sessions a Sue's trace joins to are shown", async () => {
  const view = await blindView({ runId: "r1", dir: makeRun(), events: EVENTS, site: "site-1", write: false });
  assert.equal(view.visitors[0].timeline.length, 1);
  assert.equal(view.visitors[1].timeline.length, 7);
  assert.equal(view.eventCount, 8);
});

test("the timeline is chronological with t in seconds since that session's first event, to one decimal", async () => {
  const view = await blindView({ runId: "r1", dir: makeRun(), events: EVENTS, site: "site-1", write: false });
  const ann = view.visitors[1];
  assert.deepEqual(
    ann.timeline.map((e) => e.t),
    [0, 2.5, 4, 6, 9, 10, 11],
  );
  assert.equal(view.visitors[0].timeline[0].t, 0);
});

test("each timeline entry keeps its event fields and props, minus the tracking blobs; engagement only when non-zero", async () => {
  const view = await blindView({ runId: "r1", dir: makeRun(), events: EVENTS, site: "site-1", write: false });
  const [first, scroll, click, dead, engaged, zero, error] = view.visitors[1].timeline;
  assert.deepEqual(
    { type: first.event_type, name: first.event_name, path: first.page_path },
    { type: "pageview", name: "page_view", path: "/" },
  );
  assert.equal(first.experiment_pricing, "b");
  assert.equal(scroll.depth, 75);
  assert.equal(click.element_text, "Yearly price");
  assert.equal(click.element_href, "https://ticket.test/premium#yearly");
  assert.equal(dead.page_path, "/premium");
  assert.equal(engaged.engagement_time_ms, 42000);
  assert.ok(!("engagement_time_ms" in zero));
  assert.equal(error.message, "boom");
});

test("each visitor carries device, browser, os, country, referrer, first-touch and arms, and a derived summary", async () => {
  const view = await blindView({ runId: "r1", dir: makeRun(), events: EVENTS, site: "site-1", host: "ticket.test", write: false });
  const ann = view.visitors[1];
  assert.equal(view.site.id, "site-1");
  assert.equal(view.site.host, "ticket.test");
  assert.equal(ann.device_type, "desktop");
  assert.equal(ann.browser, "Chrome");
  assert.equal(ann.os, "Windows");
  assert.equal(ann.country, "GB");
  assert.equal(ann.referrer, "https://news.test/story");
  assert.equal(ann.firstTouch, "referral");
  assert.deepEqual(ann.experimentArms, ["experiment_pricing=b"]);
  assert.deepEqual(ann.summary, { secondsFirstToLast: 11, maxScrollDepth: 75, clickCount: 1, signals: { dead_click: 1 }, errors: 1 });
});

test("a blind view written to disk is the only file it adds to the run folder", async () => {
  const dir = makeRun();
  const view = await blindView({ runId: "r1", dir, events: EVENTS, site: "site-1" });
  const file = path.join(dir, "blind-view.json");
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(JSON.stringify(view)));
  assert.ok(!fs.readFileSync(file, "utf8").includes(dir));
});

test("the blind view is pure ASCII on disk and on stdout, and parses back to the exact page text", async () => {
  const SNIPPET = "Free forever · nothing to cancel — 🎉 ok";
  const dir = makeRun();
  const events = [
    ...EVENTS,
    raw({
      occurred_at: at(12),
      session_id: "S-ann",
      page_path: "/premium",
      event_type: "click",
      event_name: "click",
      element_text: SNIPPET,
    }),
  ];
  const view = await blindView({ runId: "r1", dir, events, site: "site-1" });
  const bytes = fs.readFileSync(path.join(dir, "blind-view.json"));
  assert.ok(
    bytes.every((b) => b < 0x80),
    "every byte of blind-view.json is ASCII",
  );
  assert.ok(JSON.stringify(JSON.parse(bytes.toString("utf8"))).includes(SNIPPET));
  const stdout = Buffer.from(asciiJson({ ok: true, ...view }), "utf8");
  assert.ok(
    stdout.every((b) => b < 0x80),
    "every byte of the stdout JSON is ASCII",
  );
  assert.ok(JSON.stringify(JSON.parse(stdout.toString("utf8"))).includes(SNIPPET));
});

test("a failed fetch says so in fetchNote and never invents visitors", async () => {
  const call = async (tool, args) => {
    if (tool === "connections_search_catalog") return { results: [{ tool_name: args.query, endpoint_id: args.query }] };
    return { body: { error: "unknown_project", hint: "pass a project" } };
  };
  const view = await blindView({
    runId: "r1",
    dir: makeRun(),
    call,
    site: "site-1",
    project: "a0e52527-9a70-4ec8-86db-88ca97231d0f",
    write: false,
  });
  assert.match(view.fetchNote, /unknown_project/);
  assert.deepEqual(view.visitors, []);
});

const rest = (s, ms, words, props = {}) =>
  raw({
    session_id: "S-ann",
    occurred_at: at(s),
    event_type: "text_dwell",
    event_name: null,
    page_path: "/premium",
    props: { ms, words, snippet: "line", ...props },
  });
const paceRun = async (events) => (await blindView({ runId: "r1", dir: makeRun(), events, site: "site-1", write: false })).visitors[0];

test("a text rest carries ms_per_word and pace_x against the visitor's median over counting rests", async () => {
  const visitor = await paceRun([
    rest(0, 2000, 10),
    rest(5, 1000, 5),
    rest(10, 800, 4),
    rest(15, 4700, 9, { snippet: "10 Tickets a minute, shared by the whole server" }),
    rest(20, 3600, 26, { snippet: "Faster Premium Only Bot" }),
  ]);
  const pace = visitor.timeline.map((e) => [e.ms_per_word, e.pace_x]);
  assert.deepEqual(pace, [
    [200, 1],
    [200, 0.7],
    [200, 0.5],
    [522, 2.6],
    [138, 0.7],
  ]);
});

test("a short block rested the pixel's minimum time is not read as slow against the visitor's pace", async () => {
  const visitor = await paceRun([
    rest(0, 2200, 10),
    rest(5, 1100, 5),
    rest(10, 880, 4),
    rest(15, 1700, 2, { snippet: "Support Server" }),
  ]);
  const label = visitor.timeline.at(-1);
  assert.deepEqual([label.ms_per_word, label.pace_x], [850, 1.1]);
});

test("a long block keeps its pace against its own reading time", async () => {
  const visitor = await paceRun([
    rest(0, 3000, 10),
    rest(5, 1500, 5),
    rest(10, 1200, 4),
    rest(15, 6000, 9, { snippet: "10 Tickets a minute, shared by the whole server" }),
  ]);
  const block = visitor.timeline.at(-1);
  assert.equal(block.pace_x, 2.2);
});

test("a top_dwells entry compares its ms with the pixel's minimum for each rest it sums", async () => {
  const visitor = await paceRun([
    rest(0, 2200, 10),
    rest(5, 1100, 5),
    rest(10, 880, 4),
    raw({
      session_id: "S-ann",
      occurred_at: at(25),
      event_type: "attention",
      event_name: null,
      page_path: "/premium",
      props: { top_dwells: [{ snippet: "Support Server", ms: 3400, words: 2, rests: 2 }] },
    }),
  ]);
  const [entry] = visitor.timeline.at(-1).top_dwells;
  assert.equal(entry.pace_x, 1.1);
});

test("a partial rest is left out of the median but still carries both fields", async () => {
  const visitor = await paceRun([rest(0, 1000, 10), rest(5, 2000, 10), rest(10, 3000, 10), rest(15, 9000, 10, { partial: true })]);
  const [a, b, c, partial] = visitor.timeline;
  assert.deepEqual([a.pace_x, b.pace_x, c.pace_x], [0.5, 1, 1.5]);
  assert.deepEqual({ ms_per_word: partial.ms_per_word, pace_x: partial.pace_x }, { ms_per_word: 900, pace_x: 4.5 });
});

test("fewer than three counting rests gives both fields null, with words missing or zero", async () => {
  const visitor = await paceRun([rest(0, 2000, 10), rest(5, 3000, 10), rest(10, 4000, 2), rest(15, 5000, 0), rest(20, 1000, undefined)]);
  assert.equal(visitor.timeline.length, 5);
  for (const e of visitor.timeline) assert.deepEqual([e.ms_per_word, e.pace_x], [null, null]);
});

test("top_dwells entries carry both fields against the same visitor median", async () => {
  const visitor = await paceRun([
    rest(0, 2000, 10),
    rest(5, 1000, 5),
    rest(10, 800, 4),
    raw({
      session_id: "S-ann",
      occurred_at: at(25),
      event_type: "attention",
      event_name: null,
      page_path: "/premium",
      props: {
        top_dwells: [
          { snippet: "10 Tickets a minute", ms: 4700, words: 9 },
          { snippet: "Faster Premium Only Bot", ms: 3600, words: 26 },
          { snippet: "no words", ms: 1000 },
          { snippet: "zero words", ms: 1000, words: 0 },
        ],
      },
    }),
  ]);
  const [first, second, missing, zero] = visitor.timeline.at(-1).top_dwells;
  assert.deepEqual([first.snippet, first.ms_per_word, first.pace_x], ["10 Tickets a minute", 522, 2.6]);
  assert.deepEqual([second.ms_per_word, second.pace_x], [138, 0.7]);
  assert.deepEqual([missing.ms_per_word, missing.pace_x], [null, null]);
  assert.deepEqual([zero.ms_per_word, zero.pace_x], [null, null]);
});

test("the CLI takes --blind alongside the same --json input", () => {
  const cli = parseCli([
    "analytics",
    "--blind",
    "--json",
    '{"runId":"20261011-103828-db1f","site":"b8459c41-149b-4bf0-858b-30e92d1d5f9c","project":"ExampleApp"}',
  ]);
  assert.equal(cli.args.blind, true);
  assert.equal(cli.args.site, "b8459c41-149b-4bf0-858b-30e92d1d5f9c");
});

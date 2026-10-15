// analytics-view: a run's ARGUS rows join to each Sue by argus_sid, and the score says which of her stated themes
// analytics alone shows. Recorded fixtures only, no network.
// Run: node --test sue/tests/analytics-view.spec.mjs

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyticsView, projectRow, savedSummary, summaryLines, themesOf } from "../analytics-view.mjs";

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

// Two Sues. Ann's pixel ran (sid S-ann): she read deeply, hit a dead click twice, and said two things. Bo's pixel was
// blocked (no id on any hop). Her trace also holds an `end` row carrying a stale id that must be ignored.
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "av-"));
  roots.push(dir);
  const sue = (id, trace, interview, findings = []) => {
    const d = path.join(dir, id);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "trace.jsonl"), jsonl(trace));
    fs.writeFileSync(path.join(d, "interview.json"), JSON.stringify(interview));
    fs.writeFileSync(path.join(d, "findings.jsonl"), jsonl(findings));
    fs.writeFileSync(path.join(d, "summary.json"), JSON.stringify({ persona: id }));
  };
  sue(
    "sue-1-ann",
    [
      { kind: "hop", url: "https://x.test/", argus_sid: "S-ann", argus_anon: "A1" },
      { kind: "hop", url: "https://x.test/premium", argus_sid: "S-ann", argus_anon: "A1" },
      { kind: "end", argus_sid: "S-stale" },
    ],
    {
      mostConfusing: "I could not tell what the Yearly price button did",
      whyStopped: "Nothing happened when I pressed things",
      starsOutOfFive: 2,
      fixFirst: "Nothing.",
    },
  );
  sue("sue-2-bo", [{ kind: "hop", url: "https://x.test/", argus_sid: null, argus_anon: null }, { kind: "end" }], {
    mostConfusing: "The page was very long",
    starsOutOfFive: 4,
  });
  return dir;
}

const bigPolicy = "x".repeat(5000);
const raw = (over) => ({ occurred_at: "2026-10-11T14:00:00.000Z", page_path: "/", props: { tracking_policy: bigPolicy }, ...over });
const EVENTS = [
  raw({ event_type: "pageview", event_name: "page_view", session_id: "S-ann", page_path: "/" }),
  raw({ event_type: "scroll", event_name: "scroll", session_id: "S-ann", page_path: "/", props: { depth: 75 } }),
  raw({
    event_type: "click",
    event_name: "click",
    session_id: "S-ann",
    page_path: "/premium",
    element_text: "Yearly price toggle with a very long label that goes on and on",
  }),
  raw({ event_type: "custom", event_name: "dead_click", session_id: "S-ann", page_path: "/premium", element_text: "Yearly price" }),
  raw({ event_type: "custom", event_name: "dead_click", session_id: "S-ann", page_path: "/premium" }),
  raw({ event_type: "user_engagement", event_name: "user_engagement", session_id: "S-ann", props: { engagement_time_ms: 42000 } }),
  raw({ event_type: "pageview", event_name: "page_view", session_id: "S-someone-else" }),
  raw({ event_type: "pageview", event_name: "page_view", session_id: "S-stale" }),
];

test("rows join to a Sue by argus_sid only; an end row's id and other visitors' rows are ignored", async () => {
  const dir = makeRun();
  const view = await analyticsView({ runId: "r1", dir, events: EVENTS, write: false });
  const ann = view.sues.find((s) => s.sueId === "sue-1-ann");
  assert.equal(ann.rows, 6);
  assert.deepEqual(ann.argusSids, ["S-ann"]);
  assert.equal(ann.maxScroll, 75);
  assert.equal(ann.engagementSeconds, 42);
  assert.deepEqual(ann.signals, { dead_click: 2 });
  assert.ok(ann.clicks[0].text.length <= 40);
  assert.equal(view.rowsJoined, 6);
});

test("a Sue with no ARGUS rows is 'not seen' and none of her themes can be shown", async () => {
  const view = await analyticsView({ runId: "r1", dir: makeRun(), events: EVENTS, write: false });
  const bo = view.sues.find((s) => s.sueId === "sue-2-bo");
  assert.equal(bo.seen, false);
  assert.equal(bo.reading, "not seen");
  assert.ok(bo.themes.length > 0 && bo.themes.every((t) => t.shown === "not"));
  assert.match(summaryLines(view).join("\n"), /sue-2-bo: NOT SEEN/);
});

test("the score: a confusion the clicks and dead clicks show is inferable, a 'nothing happened' rating on a deep read is not", async () => {
  const view = await analyticsView({ runId: "r1", dir: makeRun(), events: EVENTS, write: false });
  const ann = view.sues.find((s) => s.sueId === "sue-1-ann");
  assert.equal(ann.reading, "struggled");
  const by = Object.fromEntries(ann.themes.map((t) => [t.kind, t]));
  assert.equal(by.confusion.shown, "inferable");
  assert.ok(by.confusion.evidence.length > 0);
  assert.equal(by.rating.shown, "inferable"); // 2 stars matches a struggled visit
  assert.equal(by.complaint, undefined); // "Nothing." is no theme
  assert.equal(view.agreement.stated, ann.themes.length + 2);
  assert.ok(view.agreement.inferable >= 2 && view.agreement.not >= 2);
});

test("a theme the rows cannot show is 'not': praise-free skim with a long-page complaint", async () => {
  const quiet = [raw({ event_type: "pageview", event_name: "page_view", session_id: "S-ann" })];
  const view = await analyticsView({ runId: "r1", dir: makeRun(), events: quiet, write: false });
  const ann = view.sues.find((s) => s.sueId === "sue-1-ann");
  assert.equal(ann.reading, "bounced");
  assert.equal(ann.themes.find((t) => t.kind === "confusion").shown, "partly");
  assert.equal(ann.themes.find((t) => t.kind === "rating").shown, "inferable"); // a bounce fits 2 stars
});

test("projectRow drops the tracking_policy blob; the view is written and its lines are short", async () => {
  const projected = projectRow(EVENTS[0]);
  assert.ok(!JSON.stringify(projected).includes("xxxx"));
  const dir = makeRun();
  const view = await analyticsView({ runId: "r1", dir, events: EVENTS });
  assert.ok(fs.existsSync(path.join(dir, "analytics-view.json")));
  assert.ok(view.lines.length <= 40);
  assert.deepEqual(savedSummary(dir), view.lines);
});

test("when analytics cannot be fetched the view says so instead of scoring a guess", async () => {
  const call = async (tool) => {
    if (tool === "connections_search_catalog") return { results: [{ tool_name: "get_api_v2_analytics_sites", endpoint_id: "e1" }] };
    return { body: { sites: [] } };
  };
  const view = await analyticsView({ runId: "r1", dir: makeRun(), call, write: false });
  assert.match(view.fetchNote, /analytics unavailable/);
  assert.equal(view.seen, 0);
});

const PROJ = "a0e52527-9a70-4ec8-86db-88ca97231d0f";

test("the sites and events/raw calls are pinned to the project that owns the site", async () => {
  const seen = [];
  const call = async (tool, args) => {
    if (tool === "connections_search_catalog") return { results: [{ tool_name: args.query, endpoint_id: args.query }] };
    seen.push(args);
    return args.endpoint_id === "get_api_v2_analytics_events_raw"
      ? { status: 200, body: { events: EVENTS, next_cursor: null } }
      : { body: { sites: [] } };
  };
  const view = await analyticsView({ runId: "r1", dir: makeRun(), call, site: "site-1", project: PROJ, write: false });
  assert.ok(seen.length > 0 && seen.every((a) => a.project === PROJ));
  assert.equal(view.seen, 1);
});

test("an error answer without a status is a failed call, never an empty 'not seen' run", async () => {
  const call = async (tool, args) => {
    if (tool === "connections_search_catalog") return { results: [{ tool_name: args.query, endpoint_id: args.query }] };
    return { body: { error: "unknown_project", hint: "pass a project" } };
  };
  const view = await analyticsView({ runId: "r1", dir: makeRun(), call, site: "site-1", write: false });
  assert.match(view.fetchNote, /unknown_project/);
});

test("a project NAME resolves through the companies list; an unknown or ambiguous name fails", async () => {
  const companies = [
    { name: "ExampleApp", projectName: "ExampleApp", projectId: PROJ },
    { name: "ExampleApp Next", projectName: "ExampleApp Next", projectId: "347745f0-476b-4591-8fe4-0823e981dd3b" },
  ];
  const seen = [];
  const call = async (tool, args) => {
    if (tool === "connections_search_catalog") return { results: [{ tool_name: args.query, endpoint_id: args.query }] };
    seen.push(args);
    return { status: 200, body: { events: EVENTS, next_cursor: null } };
  };
  const listProjects = async () => companies;
  const view = await analyticsView({ runId: "r1", dir: makeRun(), call, listProjects, site: "site-1", project: "ExampleApp", write: false });
  assert.ok(seen.every((a) => a.project === PROJ));
  assert.equal(view.seen, 1);
  const bad = await analyticsView({ runId: "r1", dir: makeRun(), call, listProjects, site: "site-1", project: "Nope", write: false });
  assert.match(bad.fetchNote, /matched 0 workspaces/);
});

test("engagement_time_ms arrives from Athena as a numeric string and is read as a number", () => {
  assert.equal(projectRow({ id: "1", event_name: "user_engagement", session_id: "s", engagement_time_ms: "4200" }).engagementMs, 4200);
});

// Run 20261011-094118-b19e: a hook note and a neutral thought were filed as complaints.
test("a brain note that praises or merely narrates is not a complaint", () => {
  const findings = [
    { source: "brain", kind: "hook", text: "Clear pitch: private channel per ticket." },
    {
      source: "brain",
      kind: "thought",
      text: "Clear enough: Discord ticket bot, free plus Premium from $7.99/mo per server. Checking pricing.",
    },
    { source: "brain", kind: "delight", text: "The member logos are a nice touch." },
    { source: "brain", kind: "annoyance", text: "The counter says 0 M+ tickets." },
  ];
  const themes = themesOf({}, findings);
  assert.deepEqual(
    themes.map((t) => [t.kind, t.said]),
    [
      ["praise", "Clear pitch: private channel per ticket."],
      ["praise", "The member logos are a nice touch."],
      ["complaint", "The counter says 0 M+ tickets."],
    ],
  );
});

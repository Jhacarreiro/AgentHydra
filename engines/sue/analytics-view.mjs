/**
 * analytics-view.mjs - could analytics alone have inferred what each Sue said?
 *
 * Reads the ARGUS rows a run left (events/raw, dataset=sue, sue_run=<runId>), joins them to each Sue by the
 * `argus_sid` her trace recorded (exact; a blocked pixel leaves no id and she is "not seen"), shows what the rows say
 * (pages, scroll, engagement, clicks, signals, errors, a reading) and scores each theme she stated as
 * inferable / partly / not. Raw rows carry a big tracking_policy prop, so `projectRow` keeps a few fields only.
 * Network is confined to `fetchRunEvents` (injectable `call`); the rest is pure and fixture-tested.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDir as runDirOf } from "./lib/run-dir.mjs";

const SIGNAL_EVENTS = [
  "dead_click",
  "rage_click",
  "disabled_click",
  "idle",
  "hover_dwell",
  "nav_back",
  "dialog_dismiss",
  "expand_collapse",
];
const STRUGGLE_SIGNALS = ["dead_click", "rage_click", "disabled_click", "nav_back", "dialog_dismiss"];
const CLICK_TEXT_MAX = 40;
const MAX_CLICKS = 8;
const EVENTS_RAW_ENDPOINT = "get_api_v2_analytics_events_raw";
const SITES_ENDPOINT = "get_api_v2_analytics_sites";
const MAX_PAGES = 20;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const readJsonl = (file) => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const parseProps = (props) => {
  if (typeof props !== "string") return props && typeof props === "object" ? props : {};
  try {
    return JSON.parse(props);
  } catch {
    return {};
  }
};

/** Keep only the fields this view reads: the tracking_policy blob and the rest never leave this function. */
export function projectRow(row) {
  const props = parseProps(row.props);
  return {
    at: row.occurred_at ?? null,
    type: row.event_type ?? null,
    name: row.event_name ?? null,
    path: row.page_path ?? null,
    sid: row.session_id ?? null,
    anon: row.anonymous_id ?? null,
    text: typeof row.element_text === "string" ? row.element_text : null,
    depth: Number.isFinite(Number(props.depth)) ? Number(props.depth) : null,
    engagementMs: Number.isFinite(Number(row.engagement_time_ms ?? props.engagement_time_ms))
      ? Number(row.engagement_time_ms ?? props.engagement_time_ms)
      : null,
    message: typeof (props.message ?? props.error_message) === "string" ? String(props.message ?? props.error_message).slice(0, 120) : null,
  };
}

const rowsOf = (input, map = projectRow) => {
  const body = input?.body ?? input;
  const rows = Array.isArray(body) ? body : (body?.events ?? body?.items ?? []);
  return rows.map(map);
};

// ---------------------------------------------------------------- reading a run

/** The ids her trace holds: hop rows only; a `kind:"end"` row is bookkeeping and never counts. */
export function traceIds(traceRows) {
  const sids = new Set();
  for (const row of traceRows) {
    if (row.kind === "end" || !row.argus_sid) continue;
    sids.add(row.argus_sid);
  }
  return [...sids];
}

const NOTHING = /^(nothing|none|no|n\/a|nope|not really)\b/i;

const POSITIVE_BRAIN_KINDS = new Set(["praise", "liked", "delight", "hook"]);

/** Every theme a Sue stated, from her interview and her own brain findings. */
export function themesOf(interview, findings) {
  const themes = [];
  const add = (kind, text) => {
    const clean = typeof text === "string" ? text.trim() : "";
    if (clean && !NOTHING.test(clean)) themes.push({ kind, said: clean.slice(0, 200) });
  };
  add("confusion", interview?.mostConfusing);
  add("complaint", interview?.fixFirst);
  add("stopped", interview?.whyStopped);
  if (typeof interview?.starsOutOfFive === "number") {
    themes.push({ kind: "rating", said: `${interview.starsOutOfFive} of 5`, stars: interview.starsOutOfFive });
  }
  for (const f of findings) {
    if (f.source !== "brain" || !f.text) continue;
    if (f.kind === "done" || f.kind === "bored" || f.kind === "thought") continue;
    const kind = POSITIVE_BRAIN_KINDS.has(f.kind) ? "praise" : f.kind === "confused" ? "confusion" : "complaint";
    add(kind, f.text);
  }
  const seen = new Set();
  return themes.filter((t) => (seen.has(`${t.kind}|${t.said}`) ? false : seen.add(`${t.kind}|${t.said}`)));
}

export function loadRun(dir) {
  const manifest = readJson(path.join(dir, "manifest.json")) ?? {};
  const sues = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("sue-"))
    .map((e) => {
      const sueDir = path.join(dir, e.name);
      const summary = readJson(path.join(sueDir, "summary.json")) ?? {};
      const trace = readJsonl(path.join(sueDir, "trace.jsonl"));
      const sids = [...new Set([...traceIds(trace), ...(Array.isArray(summary.argusSids) ? summary.argusSids : [])])];
      return {
        sueId: e.name,
        persona: summary.persona ?? null,
        sids,
        hops: trace.filter((r) => r.kind !== "end" && r.url).length,
        themes: themesOf(readJson(path.join(sueDir, "interview.json")), readJsonl(path.join(sueDir, "findings.jsonl"))),
      };
    });
  return {
    runId: path.basename(dir),
    projectId: manifest.projectId ?? manifest.project ?? null,
    target: manifest.target ?? null,
    targetFile: manifest.targetFile ?? null,
    sues,
  };
}

// ---------------------------------------------------------------- what the rows show

const trunc = (s) => (s.length > CLICK_TEXT_MAX ? `${s.slice(0, CLICK_TEXT_MAX - 1)}…` : s);

export function viewOf(rows) {
  const pages = [];
  const scroll = {};
  const clicks = [];
  const signals = {};
  const errors = [];
  let engagementMs = 0;
  for (const r of rows) {
    if (r.path && !pages.includes(r.path)) pages.push(r.path);
    if (r.type === "scroll" && r.path && r.depth !== null) scroll[r.path] = Math.max(scroll[r.path] ?? 0, r.depth);
    if (r.type === "user_engagement" || r.name === "user_engagement") engagementMs += r.engagementMs ?? 0;
    if (r.type === "click" || r.name === "click") {
      if (clicks.length < MAX_CLICKS) clicks.push({ path: r.path, text: trunc(r.text ?? "") });
    }
    if (SIGNAL_EVENTS.includes(r.name)) {
      signals[r.name] = (signals[r.name] ?? 0) + 1;
    }
    if (r.type === "error" || r.name === "error") errors.push({ path: r.path, message: r.message });
  }
  const maxScroll = Math.max(0, ...Object.values(scroll));
  return {
    pages,
    scroll,
    maxScroll,
    engagementSeconds: Math.round(engagementMs / 1000),
    clicks,
    clickCount: rows.filter((r) => r.type === "click" || r.name === "click").length,
    signals,
    errors,
  };
}

/** The analytics-only reading, with the evidence it rests on. */
export function readingOf(view, seen) {
  if (!seen) return { reading: "not seen", evidence: ["no ARGUS rows joined by argus_sid (pixel blocked or no id recorded)"] };
  const struggle = STRUGGLE_SIGNALS.reduce((n, k) => n + (view.signals[k] ?? 0), 0);
  const ev = [];
  if (struggle >= 2) {
    for (const k of STRUGGLE_SIGNALS) if (view.signals[k]) ev.push(`${view.signals[k]} ${k}`);
    return { reading: "struggled", evidence: ev };
  }
  if (view.errors.length)
    return {
      reading: "errored",
      evidence: [
        `${view.errors.length} error event(s)`,
        ...view.errors
          .slice(0, 2)
          .map((e) => e.message)
          .filter(Boolean),
      ],
    };
  if (view.maxScroll >= 75 || view.engagementSeconds >= 60) {
    return { reading: "read deeply", evidence: [`max scroll ${view.maxScroll}%`, `${view.engagementSeconds}s engaged`] };
  }
  if (view.pages.length <= 1 && view.engagementSeconds < 10 && view.maxScroll < 25 && view.clickCount === 0) {
    return {
      reading: "bounced",
      evidence: [`${view.pages.length} page, ${view.engagementSeconds}s engaged, max scroll ${view.maxScroll}%`],
    };
  }
  return {
    reading: "skimmed",
    evidence: [`max scroll ${view.maxScroll}%`, `${view.engagementSeconds}s engaged`, `${view.pages.length} page(s)`],
  };
}

// ---------------------------------------------------------------- the score

const level = (inferable, partly) => (inferable ? "inferable" : partly ? "partly" : "not");

/**
 * Whether analytics alone shows one stated theme. The rules are deliberately plain and listed here so a miss can be
 * argued with: a complaint or confusion shows as friction signals or errors (partly: a short or shallow visit);
 * why-she-stopped shows as a bounce or the end of a long read (partly: any visit); praise as a deep read with no
 * friction (partly: a skim); a rating as the reading that goes with it (partly: a neighbouring reading).
 */
export function scoreTheme(theme, view, reading) {
  if (reading.reading === "not seen") return { ...theme, shown: "not", evidence: ["Sue not seen by analytics"] };
  const friction = STRUGGLE_SIGNALS.reduce((n, k) => n + (view.signals[k] ?? 0), 0) + view.errors.length;
  const idle = view.signals.idle ?? 0;
  const said = theme.said.toLowerCase();
  const named = view.pages.filter((p) => p.length > 1 && said.includes(p.replace(/^\//, "").toLowerCase()));
  const namedClick = view.clicks.filter((c) => c.text.length >= 4 && said.includes(c.text.toLowerCase()));
  const evidence = [];
  let shown;
  switch (theme.kind) {
    case "complaint":
    case "confusion": {
      if (friction) evidence.push(`${friction} friction event(s)`);
      if (named.length) evidence.push(`names a visited page: ${named[0]}`);
      if (namedClick.length) evidence.push(`names a clicked element: ${namedClick[0].text}`);
      if (/\b(error|broken|bug|crash|not defined|0\.0m|undefined|nan)\b/.test(said) && view.errors.length)
        evidence.push("error event matches an error she described");
      shown = level(
        friction >= 2 || evidence.length >= 2,
        friction === 1 || idle > 0 || evidence.length === 1 || reading.reading === "bounced",
      );
      if (shown === "partly" && !evidence.length) evidence.push(idle ? `${idle} idle` : `reading: ${reading.reading}`);
      break;
    }
    case "stopped": {
      evidence.push(`reading: ${reading.reading}`);
      shown = level(reading.reading === "bounced" || reading.reading === "struggled" || reading.reading === "errored", true);
      break;
    }
    case "praise": {
      evidence.push(`reading: ${reading.reading}`, `max scroll ${view.maxScroll}%`);
      shown = level(reading.reading === "read deeply" && friction === 0, reading.reading === "skimmed" && friction === 0);
      break;
    }
    case "rating": {
      const stars = theme.stars;
      const good = stars >= 4;
      const bad = stars <= 2;
      evidence.push(`reading: ${reading.reading}`);
      const matches = good
        ? reading.reading === "read deeply"
        : bad
          ? ["bounced", "struggled", "errored"].includes(reading.reading)
          : reading.reading === "skimmed";
      const near = good
        ? reading.reading === "skimmed"
        : bad
          ? reading.reading === "skimmed"
          : ["read deeply", "bounced"].includes(reading.reading);
      shown = level(matches, near);
      break;
    }
    default:
      shown = "not";
  }
  return { ...theme, shown, evidence };
}

export function analyse({ run, events, site = null, fetchNote = null }) {
  const rows = (Array.isArray(events) ? events : rowsOf(events)).filter((r) => r.sid);
  const bySid = new Map();
  for (const r of rows) bySid.set(r.sid, [...(bySid.get(r.sid) ?? []), r]);
  const sues = run.sues.map((s) => {
    const mine = s.sids.flatMap((sid) => bySid.get(sid) ?? []);
    const seen = mine.length > 0;
    const view = viewOf(mine);
    const { reading, evidence } = readingOf(view, seen);
    const themes = s.themes.map((t) => scoreTheme(t, view, { reading }));
    return {
      sueId: s.sueId,
      persona: s.persona,
      argusSids: s.sids,
      seen,
      rows: mine.length,
      ...view,
      reading,
      readingEvidence: evidence,
      themes,
    };
  });
  const all = sues.flatMap((s) => s.themes);
  const count = (v) => all.filter((t) => t.shown === v).length;
  return {
    runId: run.runId,
    target: run.target,
    site,
    fetchNote,
    generatedAt: new Date().toISOString(),
    rowsJoined: sues.reduce((n, s) => n + s.rows, 0),
    seen: sues.filter((s) => s.seen).length,
    sueCount: sues.length,
    sues,
    agreement: {
      stated: all.length,
      inferable: count("inferable"),
      partly: count("partly"),
      not: count("not"),
      share: all.length ? Math.round((count("inferable") / all.length) * 100) / 100 : null,
    },
  };
}

/** At most ~40 lines for the report text: the figure, one line per Sue, the stated themes that analytics missed. */
export function summaryLines(view, maxLines = 38) {
  const a = view.agreement;
  const lines = [
    `What analytics saw (run ${view.runId}${view.site ? `, site ${view.site}` : ""}): ${view.seen}/${view.sueCount} Sues seen, ${view.rowsJoined} rows joined by argus_sid.`,
  ];
  if (view.fetchNote) lines.push(`  ${view.fetchNote}`);
  lines.push(
    a.stated
      ? `Agreement: ${a.inferable}/${a.stated} stated themes inferable from analytics alone (${Math.round((a.share ?? 0) * 100)}%), ${a.partly} partly, ${a.not} not.`
      : "Agreement: no stated themes to score.",
  );
  for (const s of view.sues) {
    if (!s.seen) {
      lines.push(
        `- ${s.sueId}: NOT SEEN (${s.argusSids.length ? "ids recorded but no rows" : "no ARGUS id in her trace"}); ${s.themes.length} theme(s) unscorable.`,
      );
      continue;
    }
    const sig =
      Object.entries(s.signals)
        .map(([k, n]) => `${k}${n > 1 ? `x${n}` : ""}`)
        .join(" ") || "no signals";
    lines.push(
      `- ${s.sueId}: ${s.reading.toUpperCase()} - ${s.pages.length} page(s), scroll ${s.maxScroll}%, ${s.engagementSeconds}s engaged, ${s.clickCount} click(s), ${sig}, ${s.errors.length} error(s).`,
    );
    for (const t of s.themes)
      lines.push(`    ${t.shown.padEnd(9)} ${t.kind}: "${t.said.slice(0, 70)}"  [${t.evidence.slice(0, 2).join("; ")}]`);
  }
  return lines.length > maxLines
    ? [...lines.slice(0, maxLines - 1), `... ${lines.length - maxLines + 1} more line(s) in analytics-view.json`]
    : lines;
}

// ---------------------------------------------------------------- the network (the only part that is)

async function defaultCall(tool) {
  throw new Error(`analytics needs a studio call (${tool}): pass one in; this copy ships none`);
}

// The site belongs to the workspace (project) the run was launched from, not the one this process signs in as: pin the call to it.
const pinned = (project) => (project ? { project } : {});

const endpointCache = new Map();
async function endpointOf(call, toolName) {
  if (!endpointCache.has(toolName)) {
    const found = await call("connections_search_catalog", { query: toolName });
    const hit = (found.results ?? []).find((r) => r.tool_name === toolName && r.endpoint_id);
    if (!hit) throw new Error(`catalog has no endpoint for ${toolName}`);
    endpointCache.set(toolName, hit.endpoint_id);
  }
  return endpointCache.get(toolName);
}

const hostsOf = (run, targetFile) => {
  const target = (targetFile && readJson(targetFile)) || {};
  const hosts = [];
  try {
    hosts.push(new URL(target.startUrl).hostname);
  } catch {
    /* no start url */
  }
  return [...hosts, ...(target.allowedHosts ?? []).filter((h) => !h.includes("*"))];
};

/** The ARGUS site id for the run's target: a tracked site whose domain is one of the target's hosts (or a parent of it). */
export async function resolveSite({ run, siteOverride = null, project = null, call = defaultCall }) {
  if (siteOverride) return siteOverride;
  const hosts = hostsOf(run, run.targetFile);
  const listed = await call(
    "connections_execute",
    { endpoint_id: await endpointOf(call, SITES_ENDPOINT), params: {}, ...pinned(project) },
    { timeoutMs: 60_000 },
  );
  const sites = listed?.body?.sites ?? listed?.sites ?? [];
  const hit = sites.find((s) => s.domain && hosts.some((h) => h === s.domain || h.endsWith(`.${s.domain}`)));
  return hit ? hit.id : null;
}

/** An answer that is an error, or carries no events body, is a failed call: never an empty run ("not seen"). */
export function assertEventsAnswer(res) {
  const body = res?.body ?? res;
  if (res?.status && res.status >= 400) throw new Error(`events/raw ${res.status}: ${JSON.stringify(body).slice(0, 160)}`);
  if (body?.error) throw new Error(`events/raw ${body.error}${body.hint ? `: ${body.hint}` : ""}`.slice(0, 200));
  if (!Array.isArray(body) && !Array.isArray(body?.events) && !Array.isArray(body?.items))
    throw new Error("events/raw answered without an events body");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The projects this machine's workspaces hold, from the local connections_list_companies tool. */
async function defaultListProjects() {
  const { openLocalMcp, leadingJson } = await import("../dredd/lib/mcp.mjs");
  const mcp = await openLocalMcp({ root: process.cwd(), clientName: "sue-analytics" });
  try {
    const res = await mcp.call("connections_list_companies", {});
    const text = String(res?.text ?? "");
    return JSON.parse(leadingJson(text)).companies ?? [];
  } finally {
    await mcp.close();
  }
}

/** A project id as given, or resolved from an exact company/project name; throws when the name matches none or several. */
export async function resolveProject(project, listProjects = defaultListProjects) {
  if (!project || UUID.test(project)) return project ?? null;
  const hits = (await listProjects()).filter((c) => c.name === project || c.projectName === project);
  const ids = [...new Set(hits.map((c) => c.projectId).filter(Boolean))];
  if (ids.length !== 1) throw new Error(`project "${project}" matched ${ids.length} workspaces`);
  return ids[0];
}

/** Page through events/raw for the run, projecting each row as it arrives. */
export async function fetchRunEvents({ runId, site, project = null, call = defaultCall, map = projectRow }) {
  const endpoint_id = await endpointOf(call, EVENTS_RAW_ENDPOINT);
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { site, dataset: "sue", sue_run: runId, forensic: true, limit: 1000, ...(cursor ? { cursor } : {}) };
    const res = await call("connections_execute", { endpoint_id, params, ...pinned(project) }, { timeoutMs: 90_000 });
    assertEventsAnswer(res);
    out.push(...rowsOf(res, map));
    cursor = (res?.body ?? res)?.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

/** Build, write and return the analytics view for a run. `events` given = no network (tests, a saved dump). */
export async function analyticsView({
  runId,
  dir = runDirOf(runId),
  events = null,
  site = null,
  project = null,
  call = defaultCall,
  listProjects = defaultListProjects,
  write = true,
  defaultProject = null,
}) {
  const run = loadRun(dir);
  project = analyticsProject({ project, run, defaultProject });
  let rows = events ? rowsOf(events) : null;
  let resolved = site;
  let fetchNote = null;
  if (!rows) {
    try {
      project = await resolveProject(project, listProjects);
      resolved = await resolveSite({ run, siteOverride: site, project, call });
      if (!resolved)
        throw new Error(`no analytics site visible to this credential for ${hostsOf(run, run.targetFile).join(", ") || run.target}`);
      rows = await fetchRunEvents({ runId: run.runId, site: resolved, project, call });
    } catch (error) {
      rows = [];
      fetchNote = `analytics unavailable: ${String(error.message ?? error).slice(0, 160)}`;
    }
  }
  const view = analyse({ run, events: rows, site: resolved, fetchNote });
  view.lines = summaryLines(view);
  if (write) fs.writeFileSync(path.join(dir, "analytics-view.json"), `${JSON.stringify(view, null, 2)}\n`);
  return view;
}

/** What `sue report` shows: the saved view's lines when one exists (it never fetches by itself). */
export function savedSummary(dir) {
  const saved = readJson(path.join(dir, "analytics-view.json"));
  return saved?.lines ?? null;
}

// ---------------------------------------------------------------- the blind view

const BLIND_DROP_PROPS = new Set(["tracking_policy", "tracking_purpose"]);
const BLIND_DROP_KEY = /^sue/i;
const EXPERIMENT_KEY = /^(experiment|exp_|arm)/i;
const round1 = (n) => Math.round(n * 10) / 10;
const atMs = (row) => Date.parse(row.at);

/** The run's session ids, read from each Sue's trace rows and summary.argusSids (`kind:"end"` rows never count). */
function argusSidsOf(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("sue-"))
    .flatMap((e) => {
      const sueDir = path.join(dir, e.name);
      const summary = readJson(path.join(sueDir, "summary.json")) ?? {};
      const extra = Array.isArray(summary.argusSids) ? summary.argusSids : [];
      return [...traceIds(readJsonl(path.join(sueDir, "trace.jsonl"))), ...extra];
    })
    .filter(Boolean);
}

/** JSON whose bytes are all ASCII: every char above U+007F is a \uXXXX escape (surrogate pairs for astral ones). */
export function asciiJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Every column a blind visitor may show; email, sub, anonymous and session ids never leave this function. */
function blindRow(row) {
  const props = parseProps(row.props);
  const kept = Object.fromEntries(
    Object.entries(props).filter(([key]) => !BLIND_DROP_PROPS.has(key) && !BLIND_DROP_KEY.test(key) && key !== "engagement_time_ms"),
  );
  const engagementMs = Number(row.engagement_time_ms ?? props.engagement_time_ms);
  return {
    at: row.occurred_at ?? null,
    type: row.event_type ?? null,
    name: row.event_name ?? null,
    path: row.page_path ?? null,
    sid: row.session_id ?? null,
    text: typeof row.element_text === "string" ? row.element_text : null,
    href: typeof row.element_href === "string" ? row.element_href : null,
    engagementMs: Number.isFinite(engagementMs) ? engagementMs : 0,
    device: row.device_type ?? null,
    browser: row.browser ?? null,
    os: row.os ?? null,
    country: row.country ?? null,
    referrer: typeof row.referrer === "string" && row.referrer ? row.referrer : null,
    props: kept,
  };
}

const PACE_MIN_WORDS = 3;
const PACE_MIN_RESTS = 3;
// The pixel's minimum recorded text rest (services/analytics/lambda/src/pixel-signals-js.ts sets its rest timer at 1500 ms).
const PIXEL_MIN_REST_MS = 1500;
const restNumber = (v) => (v == null || v === "" ? NaN : Number(v));

const msPerWord = (ms, words) => (Number.isFinite(ms) && Number.isFinite(words) && words > 0 ? Math.round(ms / words) : null);

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The visitor's reading pace: median ms per word over her full, counting rests; null under PACE_MIN_RESTS. */
function visitorPaceMedian(timeline) {
  const counting = timeline
    .filter((e) => e.event_type === "text_dwell" && !e.partial && restNumber(e.words) >= PACE_MIN_WORDS)
    .map((e) => msPerWord(restNumber(e.ms), restNumber(e.words)))
    .filter((v) => v != null);
  return counting.length >= PACE_MIN_RESTS ? medianOf(counting) : null;
}

function paceOf(ms, words, median, rests = 1) {
  const perWord = median > 0 ? msPerWord(ms, words) : null;
  const expected = Math.max(words * median, rests * PIXEL_MIN_REST_MS);
  return { ms_per_word: perWord, pace_x: perWord == null ? null : round1(ms / expected) };
}

function addPace(timeline) {
  const median = visitorPaceMedian(timeline);
  for (const entry of timeline) {
    if (entry.event_type === "text_dwell") Object.assign(entry, paceOf(restNumber(entry.ms), restNumber(entry.words), median));
    if (Array.isArray(entry.top_dwells)) {
      entry.top_dwells = entry.top_dwells.map((d) => ({ ...d, ...paceOf(restNumber(d.ms), restNumber(d.words), median, restNumber(d.rests) || 1) }));
    }
  }
}

function visitorOf(rows, n) {
  const first = atMs(rows[0]);
  const last = atMs(rows[rows.length - 1]);
  const firstOf = (key) => rows.map((r) => r[key]).find((v) => v != null) ?? null;
  const utm = rows.map((r) => r.props).find((p) => p.utm_medium || p.utm_source);
  const depths = rows.map((r) => Number(r.props.depth)).filter(Number.isFinite);
  const signals = {};
  for (const r of rows) if (SIGNAL_EVENTS.includes(r.name)) signals[r.name] = (signals[r.name] ?? 0) + 1;
  const timeline = rows.map((r) => {
    const entry = {
      ...r.props,
      t: Number.isFinite(atMs(r)) ? round1((atMs(r) - first) / 1000) : null,
      event_type: r.type,
      event_name: r.name,
      page_path: r.path,
      element_text: r.text,
      element_href: r.href,
    };
    if (r.engagementMs) entry.engagement_time_ms = r.engagementMs;
    return entry;
  });
  addPace(timeline);
  return {
    visitor: `Visitor ${n}`,
    device_type: firstOf("device"),
    browser: firstOf("browser"),
    os: firstOf("os"),
    country: firstOf("country"),
    referrer: firstOf("referrer"),
    firstTouch: utm ? String(utm.utm_medium ?? utm.utm_source) : rows[0].referrer ? "referral" : "direct",
    experimentArms: [
      ...new Set(
        rows.flatMap((r) =>
          Object.entries(r.props)
            .filter(([k]) => EXPERIMENT_KEY.test(k))
            .map(([k, v]) => `${k}=${v}`),
        ),
      ),
    ].sort(),
    summary: {
      secondsFirstToLast: round1((last - first) / 1000),
      maxScrollDepth: depths.length ? Math.max(...depths) : null,
      clickCount: rows.filter((r) => r.type === "click").length,
      signals,
      errors: rows.filter((r) => r.type === "error" || /error/i.test(r.name ?? "")).length,
    },
    timeline,
  };
}

async function siteDomain(site, project, call) {
  const listed = await call(
    "connections_execute",
    { endpoint_id: await endpointOf(call, SITES_ENDPOINT), params: {}, ...pinned(project) },
    { timeoutMs: 60_000 },
  );
  const sites = listed?.body?.sites ?? listed?.sites ?? [];
  return sites.find((s) => s.id === site)?.domain ?? null;
}

/**
 * The run's ARGUS timelines for a blind test: visitors `Visitor N` in session start order, no Sue, persona, intent,
 * finding, theme or score in it. The only run-folder input is the session-id mapping. `events` given = no network.
 */
/**
 * Which workspace's ARGUS site a run's analytics reads: the caller's `project`, else the one the run recorded at its start,
 * else SUE_PROJECT_ID, else `defaultProject` (the workspace's own, lib/workspaces.mjs workspaceProject: what the sue door
 * filled in from the signed-in workspace before AgentHydra started the engine directly).
 */
export function analyticsProject({ project = null, run = null, defaultProject = null, env = process.env }) {
  return project ?? run?.projectId ?? env.SUE_PROJECT_ID ?? defaultProject ?? null;
}

export async function blindView({
  runId,
  dir = runDirOf(runId),
  events = null,
  site = null,
  host = null,
  project = null,
  call = defaultCall,
  listProjects = defaultListProjects,
  write = true,
  defaultProject = null,
}) {
  const sids = new Set(argusSidsOf(dir));
  let raw = events ? events.map(blindRow) : null;
  let resolvedHost = host;
  let fetchNote = null;
  if (!raw) {
    try {
      if (!site) throw new Error("no ARGUS site id given");
      project = await resolveProject(analyticsProject({ project, defaultProject }), listProjects);
      resolvedHost = resolvedHost ?? (await siteDomain(site, project, call));
      raw = await fetchRunEvents({ runId, site, project, call, map: blindRow });
    } catch (error) {
      raw = [];
      fetchNote = `analytics unavailable: ${String(error.message ?? error).slice(0, 160)}`;
    }
  }
  const bySid = new Map();
  for (const r of raw) if (r.sid && sids.has(r.sid)) bySid.set(r.sid, [...(bySid.get(r.sid) ?? []), r]);
  const sessions = [...bySid.values()].map((rows) => rows.sort((a, b) => atMs(a) - atMs(b))).sort((a, b) => atMs(a[0]) - atMs(b[0]));
  const visitors = sessions.map((rows, i) => visitorOf(rows, i + 1));
  const view = {
    runId,
    site: { id: site, host: resolvedHost },
    fetchNote,
    visitorCount: visitors.length,
    eventCount: visitors.reduce((n, v) => n + v.timeline.length, 0),
    visitors,
  };
  if (write) fs.writeFileSync(path.join(dir, "blind-view.json"), `${asciiJson(view)}\n`);
  return view;
}

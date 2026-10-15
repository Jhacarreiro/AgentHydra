// dredd/lib/vision.mjs - rung two ("does the design look good?") scored by a model with eyes, as a LABELLED
// SECOND OPINION (D39, docs/todo/chair-do-me/96-parked-until-later.md; done 2026-09-22 on "stop stopping ...
// keep going" after the recommendation named it). The rule it lives under is the owner's of 2026-08-08: the
// design bar is scored by the strongest model in the room, never a subprocess. So this never ingests, never
// moves the ratchet, and never changes the rung's state: the rung stays `yours`, the ladder prints both
// ("7/10 by gemini-3.8-flash · yours to confirm"), and the room hears the cheaper score as a fact with its label.
// `DREDD_VISION=off` turns it off; `DREDD_VISION_MODEL` names the model (default: HSwarm's vision default).
//
// What is scored: only the docket's own surfaces out of the critic's fleet-wide worklist - by id when the docket
// names them, else by the page's route and plane - with the SAME brief the session scores against (the worklist
// carries it per surface) and the same dimensions, so the two scores are comparable by construction.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readSeats } from "../../lib/people-home.mjs";
import { ENGINE_DIR, ENGINE_ROOT, matchSurfaces } from "./docket.mjs";

/** The vision score is on unless the operator says otherwise. */
export function visionEnabled(env = process.env) {
  return String(env.DREDD_VISION || "on").toLowerCase() !== "off";
}

export function visionModel(env = process.env) {
  return env.DREDD_VISION_MODEL || "auto";
}

/** A route as matchSurfaces compares it: no query, no trailing slash, "/" for the root; null for no URL. */
const routeOf = (route) =>
  String(route || "")
    .split("?")[0]
    .replace(/\/+$/, "") || "/";

function pagePath(url) {
  try {
    return routeOf(new URL(url).pathname);
  } catch {
    return null;
  }
}

/**
 * The docket's surfaces out of the worklist: the ids the docket names when it names any, else the surfaces on the
 * page's own plane at exactly the page's route. Which plane a page is on is docket.mjs matchSurfaces' host rule (www,
 * getconnections, .app/.co, localhost), and which plane a surface is on is the CAPTURE's record of it - the worklist
 * rows carry no plane, and guessing it from an id prefix missed every main surface (home-contacts) and misfiled
 * deals-explore-home under deals. A known plane with nothing on the route, a page off the worklist, and a host that is
 * not ours all score nothing: the old fallback averaged every plane's "/" into main's score (Opus 5.5 review,
 * 2026-09-22). Pure; throws when a URL has to be placed and no capture was given.
 */
export function docketSurfaces(worklist, docket, capture) {
  const all = Array.isArray(worklist?.surfaces) ? worklist.surfaces : [];
  const named = Array.isArray(docket?.surfaces) ? docket.surfaces.filter(Boolean) : [];
  if (named.length) return all.filter((s) => named.includes(s.id));
  const route = pagePath(docket?.url);
  if (!route) return [];
  if (!Array.isArray(capture?.surfaces))
    throw new Error("docketSurfaces: the capture is needed to know which plane each worklist surface is on");
  const planeById = new Map(capture.surfaces.map((s) => [s.id, s.plane]));
  // A surface the capture records no plane for is left out: matchSurfaces reads a missing plane as main.
  const placed = all.filter((s) => planeById.get(s.id)).map((s) => ({ ...s, plane: planeById.get(s.id) }));
  const onPlane = new Set(matchSurfaces(placed, docket.url, placed.length));
  // matchSurfaces falls back to the plane's landing surfaces; a vision score is of this page only, so the route is exact.
  return all.filter((s) => onPlane.has(s.id) && routeOf(s.route) === route);
}

/**
 * One surface rung two scores for a page the capture lane cannot photograph (lib/convene.mjs pageShotRung), pure: an id
 * from the URL's path, the page's title, its route, and the shots it is judged on. With `slice` ({ kind, index, of }) it
 * is one viewport slice of page-pulse's, scored alone, so its id and title say which (page-home-desk-03).
 */
export function pageShotSurface({ url, title = "", shots = [], brief = "", slice = null }) {
  let route = "/";
  let host = "";
  try {
    const u = new URL(url);
    route = routeOf(u.pathname);
    host = u.hostname;
  } catch {
    /* an unparsable url still names a surface; the route stays "/" */
  }
  const slug = route
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const base = `page-${slug || "home"}`;
  const name = title || `${host}${route}`;
  const part = slice ? `${slice.kind}-${String(slice.index).padStart(2, "0")}` : null;
  return {
    id: part ? `${base}-${part}` : base,
    title: part ? `${name}, ${slice.kind === "phone" ? "phone" : "desktop"} slice ${slice.index} of ${slice.of}` : name,
    route,
    shots: shots.map((s) => ({ state: s.state, path: s.path })),
    brief,
    ...(slice ? { slice: { kind: slice.kind, index: slice.index, of: slice.of, y: slice.y ?? null } } : {}),
  };
}

/**
 * The slices rung two should hear about first, pure: the `n` lowest-scoring, worst first, each with its issues. A page is
 * as good as its weakest section, so these are the ones the rung's number comes from.
 */
export function lowestSurfaces(surfaces, n = 3) {
  return (surfaces || [])
    .filter((s) => s.status === "ok" && Number.isInteger(s.overall))
    .sort((a, b) => a.overall - b.overall || String(a.id).localeCompare(String(b.id)))
    .slice(0, n);
}

/**
 * The Design Critic's own brief, read where it lives: the board member of that name in the Connections workspace
 * (Owner, 2026-09-28: no personality lives in a repo). The seat file only names who it is.
 */
async function designCriticBrief() {
  const seat = readSeats().find((s) => /design/i.test(String(s.id)) || /design critic/i.test(String(s.name)));
  if (!seat) throw new Error("no design-critic person in the people store (family dredd-seat)");
  const { seatWords } = await import("./connections-board.mjs");
  return (await seatWords(seat.id)).brief;
}

/**
 * The brief rung two scores an off-roster page against: the Design Critic's own seat brief and the canon the capture
 * lane's judge scores every roster surface against (the calibration ladder, then each dimension's laws), so the two
 * scores stay comparable. The canon lives in the engine's checkout; when it cannot be read the seat brief alone is the
 * brief and the score is overall only, and `source` says which. Returns { text, dimensions, nullableDimensions, source }.
 */
export async function pageShotBrief({ url, engineRoot = ENGINE_ROOT, engineDir = ENGINE_DIR, seatBrief = designCriticBrief } = {}) {
  let seat;
  try {
    seat = (await seatBrief(engineRoot, engineDir)) || "";
  } catch {
    seat = "";
  }
  const head =
    `You are the Design Critic, looking at a page that is not on Connections' capture roster: ${url}. page-pulse photographed it ` +
    `after scrolling through it with a real mouse wheel, so scroll-reveal content has fired, one viewport at a time at a 1440x900 ` +
    `desktop and a 390x844 phone. You are shown ONE of those viewports: score that section as a visitor sees it on that screen, ` +
    `at full size, not as part of a page you cannot see. The page's score is its weakest section's, so a bland, empty or ` +
    `generic section scores what it is. There is no telemetry and no plane declaration: judge what the photograph shows. ` +
    `One thing the photograph shows is not the page: each slice starts where page-pulse scrolled to, overlapping the one ` +
    `before by a tenth, and a sticky header stays on top of every slice, so a heading or box cut by the slice's top or ` +
    `bottom edge, or passing under the sticky header, is whole in the next or previous slice. That cut is the camera; never ` +
    `score it or list it as clipped (six of one home page's issues were this cut, and they set its score, 2026-09-28).`;
  const engines = path.join(engineRoot, "packages", "connections-arkitect", "agnostic", "engines", "design-critic");
  try {
    if (!existsSync(path.join(engines, "design-critic-canon.mjs"))) throw new Error("the canon's engine is not in this checkout");
    const { loadCanon, SCORE_DIMENSIONS } = await import(pathToFileURL(path.join(engines, "design-critic-canon.mjs")).href);
    const { renderCanon } = await import(pathToFileURL(path.join(engines, "design-critic-prompt.mjs")).href);
    const { canon, problems } = loadCanon(engineRoot);
    if (!canon || problems.length) throw new Error(problems[0] || "no canon");
    return {
      text: [head, seat, ...renderCanon(canon, { auth: false }, null)].filter(Boolean).join("\n\n"),
      dimensions: [...SCORE_DIMENSIONS],
      nullableDimensions: Array.isArray(canon.nullableDimensions) ? canon.nullableDimensions : ["motion"],
      source: "canon",
    };
  } catch (err) {
    return {
      text: [
        head,
        seat,
        `(The canon could not be read: ${String(err?.message || err).slice(0, 160)}. Score overall 1-10 against the brief.)`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      dimensions: ["overall"],
      nullableDimensions: [],
      source: "seat brief only",
    };
  }
}

/** The score's shape, from the worklist's own dimension list so a rubric change changes this too. An issue names the
 *  dimension it lowers, so the settle step can hold that dimension to the issue (a model scored accessibility 8 while
 *  listing a contrast failure against it, 2026-09-22). */
export function visionSchema(dimensions, nullable = []) {
  const scores = {};
  for (const d of dimensions)
    scores[d] = nullable.includes(d)
      ? { type: ["integer", "null"], minimum: 1, maximum: 10 }
      : { type: "integer", minimum: 1, maximum: 10 };
  return {
    type: "object",
    properties: {
      rung: {
        type: "string",
        description: "The calibration rung the surface sits on, named before scoring, in the brief's own words, starting with its number.",
      },
      scores: { type: "object", properties: scores, required: dimensions },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dimension: { type: "string", description: `Which dimension this lowers: one of ${dimensions.join(", ")}, or "other".` },
            note: { type: "string", description: "The element and what is wrong with it, as seen in a named screenshot." },
            law: { type: "string", description: "The law id from the brief where one applies, else empty." },
          },
          required: ["dimension", "note", "law"],
        },
        description:
          "Concrete issues, each naming the element, what is wrong, the dimension it lowers and the law id. Empty when nothing is wrong.",
      },
      summary: { type: "string", description: "Two sentences: what the surface is and the one thing that most moves its score." },
    },
    required: ["rung", "scores", "issues", "summary"],
  };
}

export function visionPrompt(surface, { nullable = [] } = {}) {
  const states = (surface.shots || []).map((s, i) => `${i + 1}. ${s.state}`).join(", ");
  const still = nullable.length ? ` ${nullable.join(", ")} is null: a screenshot cannot show it, and a number there is invented.` : "";
  return `${surface.brief || ""}\n\nYou are looking at ${(surface.shots || []).length} screenshot(s) of the surface "${surface.title || surface.id}" (${surface.route || surface.id}), in this order: ${states}. Name the calibration rung first, starting with its number, then score every dimension as an integer from 1 to 10 to that rung, never to a feeling: overall IS the rung's number.${still} Every issue you list names the dimension it lowers, and a dimension with an issue against it scores 7 at most. Cite what you can see in a named screenshot; never a pixel you cannot.`;
}

/**
 * The settle step, pure: what the model said, held to the rules it was given. Nullable dimensions are null (a
 * screenshot shows no motion); overall is the rung's number when the rung starts with one (the rung is named from
 * the brief's ladder and drifts less than a free score - the same input scored 6 and 7 on two runs); a dimension
 * named by an issue is held to 7. Returns the settled scores and the list of what was settled, for the log.
 */
export function settleScores({ rung, scores, issues }, dimensions, nullable = []) {
  const out = { ...(scores || {}) };
  const settled = [];
  for (const d of nullable) {
    if (d in out && out[d] !== null) {
      settled.push(`${d}: ${out[d]} → null (a screenshot cannot show it)`);
      out[d] = null;
    }
  }
  const m = String(rung || "").match(/^\s*(\d{1,2})\b/);
  const rungN = m ? Math.min(10, Math.max(1, Number(m[1]))) : null;
  if (rungN !== null && Number.isInteger(out.overall) && out.overall !== rungN) {
    settled.push(`overall: ${out.overall} → ${rungN} (the rung it named)`);
    out.overall = rungN;
  } else if (rungN !== null && !Number.isInteger(out.overall)) {
    settled.push(`overall: - → ${rungN} (the rung it named)`);
    out.overall = rungN;
  }
  const named = new Set((issues || []).map((i) => String(i?.dimension || "").trim()).filter((d) => dimensions.includes(d)));
  for (const d of named) {
    if (Number.isInteger(out[d]) && out[d] > 7) {
      settled.push(`${d}: ${out[d]} → 7 (an issue is listed against it)`);
      out[d] = 7;
    }
  }
  return { scores: out, settled };
}

/** One line per issue, the same whether the model answered the object shape or a bare string. */
export function issueLine(i) {
  if (typeof i === "string") return i;
  if (!i || typeof i !== "object") return String(i);
  const dim = i.dimension && i.dimension !== "other" ? `${i.dimension}: ` : "";
  const law = i.law ? ` [${i.law}]` : "";
  return `${dim}${i.note || ""}${law}`.trim();
}

/** The verdict line's words for a vision score. A worst-slice score says so: its number is the weakest section's. */
export function renderVision(v) {
  if (!v || typeof v.overall !== "number") return "";
  const over =
    v.aggregate === "min"
      ? `the WORST of ${v.scored ?? "?"} viewport slice(s) scored${v.surfaces?.length && v.scored !== v.surfaces.length ? ` (of ${v.surfaces.length})` : ""}`
      : `${v.surfaces?.length ?? "?"} surface(s)`;
  return `${v.overall}/10 by ${v.model || "a vision model"} (vision, a labelled second opinion over ${over}; the session's score moves the ratchet) · yours to confirm`;
}

/**
 * Score each surface with its shots. `askBrain` is injected so the scorer is testable without a model. `aggregate` is
 * how the surfaces' scores become one: "mean" for the roster's surfaces, "min" for the viewport slices of one page (a
 * page is as good as its weakest section). `concurrency` asks that many at once; the order of `surfaces` is kept.
 */
export async function scoreSurfaces({
  surfaces,
  worklist,
  askBrain,
  callsLog = null,
  model = visionModel(),
  aggregate = "mean",
  concurrency = 1,
}) {
  const dimensions = Array.isArray(worklist?.dimensions) && worklist.dimensions.length ? worklist.dimensions : ["overall"];
  const schema = visionSchema(dimensions, worklist?.nullableDimensions || []);
  const out = new Array(surfaces.length);
  let next = 0;
  const lane = async () => {
    for (let at = next++; at < surfaces.length; at = next++) out[at] = await scoreOne(surfaces[at]);
  };
  const scoreOne = async (s) => {
    const images = (s.shots || []).map((x) => x.path).filter(Boolean);
    const nullable = worklist?.nullableDimensions || [];
    const spec = {
      system: "You are a principal product designer scoring screenshots against the brief you are given. Answer only through the schema.",
      prompt: visionPrompt(s, { nullable }),
      schema,
      model,
      images,
      maxTokens: 2500,
      timeoutS: 240,
    };
    // An ask with screenshots fails over only to legs that can see (the zswarm's ask_routed, e802845): the first live
    // probe (2026-09-22) had a resting Gemini key hand eleven screenshots to a text-only leg, and Dredd retried and
    // refused by model name. HSwarm now answers "NoVisionLeg: ..." instead of a guess, so the score here is taken
    // as it comes, a failover inside the seeing legs included, and the model that answered is on the row.
    const res = await askBrain(spec, callsLog);
    const raw = res.data?.scores && typeof res.data.scores === "object" ? res.data.scores : null;
    const issues = Array.isArray(res.data?.issues) ? res.data.issues.slice(0, 12) : [];
    const held = raw ? settleScores({ rung: res.data?.rung, scores: raw, issues }, dimensions, nullable) : { scores: null, settled: [] };
    const scores = held.scores;
    const overall = scores && Number.isInteger(scores.overall) ? scores.overall : null;
    const error = res.status === "ok" && overall !== null ? null : res.error || "no overall score came back";
    return {
      id: s.id,
      title: s.title || s.id,
      route: s.route || null,
      ...(s.slice ? { slice: s.slice } : {}),
      inputHash: s.inputHash || null,
      shots: images.length,
      model: res.model || model,
      status: error ? "error" : "ok",
      error,
      rung: res.data?.rung || null,
      overall,
      scores,
      issues,
      settled: held.settled,
      summary: typeof res.data?.summary === "string" ? res.data.summary : "",
      seconds: res.seconds ?? null,
      cost_usd: res.cost_usd ?? null,
    };
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, surfaces.length)) }, lane));
  const scored = out.filter((r) => r.status === "ok");
  const overall = !scored.length
    ? null
    : aggregate === "min"
      ? Math.min(...scored.map((r) => r.overall))
      : Math.round(scored.reduce((a, r) => a + r.overall, 0) / scored.length);
  return { model: scored[0]?.model || model, overall, aggregate, surfaces: out, scored: scored.length };
}

/** The log the room reads: one block per surface, the score first, the issues as the critic would list them. */
export function renderVisionLog(v) {
  const lines = [
    `$ rung two, scored by a vision model as a labelled second opinion (never ingested; the session's score moves the ratchet)`,
    ``,
  ];
  if (!v || !v.surfaces?.length)
    return [...lines, "no surface of this docket is on the critic's worklist - nothing to score", "", "--- exit 0 ---", ""].join("\n");
  if (v.aggregate === "min") {
    // The rung is the weakest slice's number, so the room reads the weakest first.
    for (const n of v.notes || []) lines.push(`NOT SCORED: ${n}`);
    lines.push(`THE RUNG IS THE WORST SLICE. The three lowest:`);
    for (const s of lowestSurfaces(v.surfaces))
      lines.push(
        `- ${s.overall}/10 ${s.title}: ${(s.issues || []).slice(0, 3).map(issueLine).join(" | ") || s.summary || "no issue named"}`,
      );
    lines.push(``);
  }
  for (const s of v.surfaces) {
    lines.push(
      `## ${s.title} (${s.id}${s.route ? `, ${s.route}` : ""}) - ${s.status === "ok" ? `${s.overall}/10 by ${s.model}` : `not scored: ${s.error}`}`,
    );
    if (s.rung) lines.push(`rung: ${s.rung}`);
    if (s.scores)
      lines.push(
        `scores: ${Object.entries(s.scores)
          .map(([k, val]) => `${k} ${val ?? "-"}`)
          .join(", ")}`,
      );
    if (s.summary) lines.push(s.summary);
    for (const i of s.issues) lines.push(`- ${issueLine(i)}`);
    for (const h of s.settled || []) lines.push(`  settled ${h}`);
    lines.push("");
  }
  lines.push(
    `overall ${v.overall ?? "-"}/10 (${v.aggregate === "min" ? "the worst" : "the mean"}) over ${v.scored} of ${v.surfaces.length} surface(s) · ${renderVision(v)}`,
    "",
    "--- exit 0 ---",
    "",
  );
  return lines.join("\n");
}

// dredd/lib/earlier.mjs - what the last hearings of this page ruled, for the room hearing it again.
//
// A page is heard, the owner changes it the way the room asked, and the page is heard again. Until 2026-09-24 the
// next room was never told what the last one asked for, so it could score the change as the opposite defect: on
// https://futurethatworks.org/founders sitting A (docket 20260923-225601-3fad) said "Delete all duplicate 'Ask about a
// founding seat' lines", the three buttons were given three different labels, and sitting B (20260923-231649-640f)
// scored that 3/10 and said "Replace all three call-to-action button texts with the unified phrase". A third hearing
// sat between them (20260923-230624-2633) and its fix was "No single fix achieved majority", so the room reads the
// last few rulings, not only the newest. lib/seats.mjs roomMaterial puts them in front of the room, and lib/ballot.mjs
// makes every ballot say whether its fix reverses one, and why that advice was wrong when it does.
//
// A leaf on purpose (node:fs and node:path only): lib/seats.mjs reads it, and lib/dockets.mjs, the other reader of
// the docket history, imports lib/hearing.mjs, which imports lib/seats.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** How many sibling dockets are read at most, newest first: the history under tmp/dredd grows without bound. */
const SCAN = 200;
/** How many earlier rulings the room reads. */
export const EARLIER_LIMIT = 3;

/**
 * The hearings of the same page before this one, newest first, at most `limit`, from the dockets beside `docketDir` (a
 * hearing's history is its root's tmp/dredd/). Only a docket with the same `url`, created before this docket, whose
 * hearing ruled on the page (a sitting over the evidence) counts; a hearing that failed or was stopped after its
 * ruling counts too, since the ruling stands. Each is { dir, when, verdict, conclusive, fix_first, proposal } where
 * `proposal` is the last proposal that hearing's room scored ({ round, verdict, headline, changes, fix_first }) or null.
 */
export function earlierHearings(docketDir, docket, { limit = EARLIER_LIMIT } = {}) {
  if (!docketDir || !docket?.url || !docket.created) return [];
  const here = path.resolve(docketDir);
  const history = path.dirname(here);
  if (!existsSync(history)) return [];
  const created = Date.parse(docket.created);
  const found = [];
  for (const f of readdirSync(history).sort().reverse().slice(0, SCAN)) {
    const dir = path.join(history, f);
    if (dir === here) continue;
    const d = readJson(path.join(dir, "docket.json"));
    if (!d || d.url !== docket.url || !(Date.parse(d.created) < created)) continue;
    // A hearing whose pulse never got past the host's bot check ruled on the check page, not on this one.
    const pulse = readJson(path.join(dir, "page-pulse.json"));
    if (pulse?.challenge?.seen && !pulse.challenge.passed) continue;
    const ruling = pageRuling(dir, readJson(path.join(dir, "hearing.json")));
    if (ruling) found.push({ when: d.created, ...ruling });
  }
  return found.sort((a, b) => Date.parse(b.when) - Date.parse(a.when)).slice(0, limit);
}

/** A hearing's ruling on the page: its last sitting over the evidence, and the last proposal its room scored. Pure over
 *  hearing.json's content; null when no sitting over the evidence reached a fix or a score. */
export function pageRuling(dir, H) {
  const sittings = Array.isArray(H?.sittings) ? H.sittings : [];
  const page = [...sittings].reverse().find((s) => !s.proposal && (s.fix_first || s.verdict != null));
  if (!page) return null;
  const scored = [...sittings].reverse().find((s) => s.proposal && s.verdict != null);
  const drafted = scored ? (H.proposals || []).find((p) => p.file === scored.proposal) : null;
  return {
    dir,
    verdict: page.verdict ?? null,
    conclusive: page.conclusive !== false && page.verdict != null,
    fix_first: page.fix_first || "",
    proposal: scored
      ? {
          round: drafted?.round ?? null,
          verdict: scored.verdict,
          headline: drafted?.headline || null,
          changes: (drafted?.changes || []).map((c) => ({ where: c.where || "", before: c.before || "", after: c.after || "" })),
          fix_first: scored.fix_first || "",
        }
      : null,
  };
}

/** The fixes the earlier hearings asked for, newest first: what a ballot is asked whether it reverses. */
export function earlierFixes(earlier) {
  return (Array.isArray(earlier) ? earlier : []).map((e) => e.fix_first).filter(Boolean);
}

const clip = (s, n) => {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

/** The rule every seat reads beside the earlier rulings, and every ballot is held to (lib/ballot.mjs earlierReversal). */
export const EARLIER_RULE =
  "The page may have been changed since to do what those hearings asked. A change that does what an earlier fix asked is not a defect: do not score the page down for it, and do not ask for its opposite, unless you say why the earlier advice was wrong.";

function changeLine(c) {
  const where = clip(c.where, 60) || "somewhere";
  if (!c.after) return `- ${where}: cut${c.before ? ` "${clip(c.before, 160)}"` : ""}`;
  return `- ${where}: ${c.before ? `"${clip(c.before, 120)}" became ` : ""}"${clip(c.after, 200)}"`;
}

/** The earlier rulings as the room reads them, newest first: when, the score, the fix, what a scored proposal changed,
 *  and the rule. "" for none. */
export function renderEarlierHearings(earlier) {
  const list = Array.isArray(earlier) ? earlier : [];
  if (!list.length) return "";
  const lines = [`This page was heard before (newest first):`];
  for (const e of list) {
    const score = e.conclusive ? `${e.verdict}/10` : "not conclusive";
    lines.push(`- ${e.when} (docket ${path.basename(e.dir)}): the page ${score}, fix first: ${e.fix_first || "-"}`);
    if (!e.proposal) continue;
    const p = e.proposal;
    lines.push(
      `  its room then scored proposal ${p.round ?? "?"}${p.headline ? ` ("${clip(p.headline, 160)}")` : ""} ${p.verdict}/10${p.changes.length ? ", which changed:" : ""}`,
    );
    for (const c of p.changes.slice(0, 4)) lines.push(`  ${changeLine(c)}`);
    if (p.changes.length > 4) lines.push(`  - ...and ${p.changes.length - 4} more`);
  }
  lines.push(EARLIER_RULE);
  return lines.join("\n");
}

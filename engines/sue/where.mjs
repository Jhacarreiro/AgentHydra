#!/usr/bin/env node
/**
 * where.mjs - where do Sues end up? Every Sue that ever ran, grouped by why she came.
 * ===================================================================================
 *
 * Owner, 2026-09-27: there are not enough real people to read human flows yet, so Sue data is the
 * stand-in - "where do the Sues end up, what do they do, where are they going from here". report.mjs
 * answers "did this one run's Sues understand the page"; this answers the fleet question across
 * every run under runs/: for each reason a Sue came (the same nine reasons as the focus catalog,
 * read off her errand), where she started, where she ended, where the site sent her after sign-up,
 * where she went on her own, whether she ever saw a price, and how she rated it.
 *
 * Mechanical only. A route is the URL's plane plus its first two path segments with ids folded to
 * `:id`; the reason is a keyword read of the errand ("just looking" when none matches, "scripted" when
 * the Sue was handed a script instead of a reason). Only Sues sent at a Connections site count unless
 * `--all-sites` is passed.
 *
 *   node sue/where.mjs [--since 2026-09-20] [--top 5] [--json] [--why-out <file.jsonl>]
 *
 * `--why-out` writes one line per Sue (reason, start plane, made account, stars, why she stopped,
 * why she would or would not come back) for a theme pass; this script never judges prose itself.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runsRoot } from "./lib/run-dir.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const since = flag("--since") ? Date.parse(flag("--since")) : 0;
const top = Number(flag("--top", "5"));

/** Checked in order, so a booking errand never reads as a writer for saying "book". Worded against
 *  the errands Sues actually carry (2026-09-27: 127 distinct errands across 2,304 Connections Sues). */
export const REASON_KEYWORDS = [
  [
    "attending",
    /\b(rsvp|attend|things to do|thing happening|class or one event|a group that meets|find (that|one|an?) (event|class)|what is on this week|ask if you can go|do the same thing she did|get you out of the house)\b/i,
  ],
  [
    "appointments",
    /\b(booking|book (time|a slot|a call|me|appointments?)|appointments?|clients? can book|customers? can book|availability|set (my )?hours)\b/i,
  ],
  [
    "organizer",
    /\b(host|hosting|run (my|our|your|the)? ?(group'?s )?events?|organi[sz]e|meetup|sign-ups and (the )?reminders|put next week'?s on here|evening fills up|client evening|networking breakfast|events? and sign-ups|event page)\b/i,
  ],
  ["seller", /\b(sell|selling|listing|marketplace|deals?|fundraiser|donations?|parcels?|postage|labels?|orders|shop|store)\b/i],
  ["writer", /\b(write a book|writing|novel|chapter|memoir|author|manuscript)\b/i],
  ["builder", /\b(api|developer|mcp|coding|integrat(e|ion)|sdk|webhook)\b/i],
  [
    "connector",
    /\b(contacts?|contact list|crm|who introduced you|people i (know|meet)|follow[- ]?ups?|relationships?|address book|writes up your calls|notes)\b/i,
  ],
];

/** No errand means the Sue was handed a script ("Make an account") instead of a reason. */
export function reasonOf(errand) {
  const text = String(errand ?? "").trim();
  if (!text) return "scripted";
  return REASON_KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? "just looking";
}

const CONNECTIONS_HOST = /(^|\.)(connections\.icu|connectionsapi\.com|getconnections\.icu)$/;

/** `example.com/e/abc123/rsvp` -> `events:/e/:id`. */
export function routeOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "(none)";
  }
  const host = u.hostname.replace(/^www\./, "");
  const plane = /^(connections\.icu|getconnections\.icu)$/.test(host)
    ? "main"
    : /(connections\.icu|connectionsapi\.com|getconnections\.icu)$/.test(host)
      ? host.split(".")[0]
      : host;
  const parts = u.pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => (/\d/.test(s) || s.length > 24 ? ":id" : s));
  return `${plane}:/${parts.join("/")}`;
}

const planeOf = (route) => route.split(":/")[0];
const sawPrice = (route) => route.startsWith("pass:") || /:\/(pricing|plans|upgrade|checkout)/.test(route) || route.startsWith("checkout:");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function hopsOf(dir) {
  const path = join(dir, "trace.jsonl");
  if (!existsSync(path)) return [];
  const hops = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"hop"')) continue;
    try {
      const h = JSON.parse(line);
      if (h.kind === "hop" && h.url) hops.push({ at: Date.parse(h.at), route: routeOf(h.url), by: h.by });
    } catch {
      /* a torn last line from a killed run */
    }
  }
  return hops;
}

export function readSue(dir) {
  const sue = readJson(join(dir, "sue.json"));
  if (!sue) return null;
  const summary = readJson(join(dir, "summary.json")) ?? {};
  const body = readJson(join(dir, "body.json")) ?? {};
  const interview = readJson(join(dir, "interview.json"));
  const startedAt = Date.parse(sue.createdAt ?? summary.startedAt ?? "") || 0;
  const hops = hopsOf(dir);
  const signedUpAt = Date.parse(summary.codeSubmittedAt ?? body.codeSubmittedAt ?? "") || null;
  const after = signedUpAt ? hops.filter((h) => h.at > signedUpAt) : [];
  const startUrl = sue.target?.startUrl ?? "";
  const startRoute = routeOf(startUrl);
  const finalRoute = body.finalUrl ? routeOf(body.finalUrl) : (hops.at(-1)?.route ?? "(none)");
  return {
    startedAt,
    persona: typeof sue.persona === "string" ? sue.persona : (sue.persona?.id ?? summary.persona),
    reason: reasonOf(sue.errand),
    onConnections: (() => {
      try {
        return CONNECTIONS_HOST.test(new URL(startUrl).hostname);
      } catch {
        return false;
      }
    })(),
    startPlane: planeOf(startRoute),
    finalRoute,
    madeAccount: summary.madeAccount === true || summary.madeAccount === "True",
    sentAfterSignup: after.find((h) => h.by === "site")?.route ?? null,
    wentAfterSignup: [...new Set(after.filter((h) => h.by === "her").map((h) => h.route))],
    sawPrice: hops.some((h) => sawPrice(h.route)),
    stars: Number(interview?.starsOutOfFive) || null,
    comingBack: interview?.everComingBack?.yes ?? null,
    whyStopped: interview?.whyStopped ?? null,
    whyBack: interview?.everComingBack?.why ?? null,
  };
}

function* sueDirs(root) {
  for (const run of readdirSync(root, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    for (const d of readdirSync(join(root, run.name), { withFileTypes: true })) {
      if (d.isDirectory() && d.name.startsWith("sue-")) yield join(root, run.name, d.name);
    }
  }
}

const count = (list) => {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

export function summarizeGroup(sues) {
  const acct = sues.filter((s) => s.madeAccount);
  const rated = sues.filter((s) => s.stars);
  const answered = sues.filter((s) => s.comingBack != null);
  return {
    sues: sues.length,
    madeAccount: acct.length,
    sawPrice: sues.filter((s) => s.sawPrice).length,
    avgStars: rated.length ? Math.round((10 * rated.reduce((n, s) => n + s.stars, 0)) / rated.length) / 10 : null,
    comingBack: `${answered.filter((s) => s.comingBack).length}/${answered.length}`,
    endedOnStartPlane: sues.filter((s) => planeOf(s.finalRoute) === s.startPlane).length,
    startPlanes: count(sues.map((s) => s.startPlane)).slice(0, top),
    endedAt: count(sues.map((s) => s.finalRoute)).slice(0, top),
    endedWithAccount: count(acct.map((s) => s.finalRoute)).slice(0, top),
    sentAfterSignup: count(acct.map((s) => s.sentAfterSignup ?? "(nowhere)")).slice(0, top),
    wentAfterSignup: count(acct.flatMap((s) => s.wentAfterSignup)).slice(0, top),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = flag("--runs-dir") ?? runsRoot();
  const sues = [];
  for (const dir of sueDirs(root)) {
    const s = readSue(dir);
    if (s && s.startedAt >= since && (s.onConnections || args.includes("--all-sites"))) sues.push(s);
  }
  const byReason = {};
  for (const s of sues) (byReason[s.reason] ??= []).push(s);
  const report = {
    since: since ? new Date(since).toISOString() : "all",
    all: summarizeGroup(sues),
    byReason: Object.fromEntries(
      Object.entries(byReason)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => [k, summarizeGroup(v)]),
    ),
  };
  if (flag("--why-out")) {
    writeFileSync(
      flag("--why-out"),
      sues
        .filter((s) => s.whyStopped || s.whyBack)
        .map((s) =>
          JSON.stringify({
            reason: s.reason,
            startPlane: s.startPlane,
            madeAccount: s.madeAccount,
            stars: s.stars,
            whyStopped: s.whyStopped,
            whyBack: s.whyBack,
          }),
        )
        .join("\n"),
    );
  }
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    const line = (label, g) =>
      `${label.padEnd(13)} ${String(g.sues).padStart(5)} Sues | account ${pct(g.madeAccount, g.sues)} | saw a price ${pct(g.sawPrice, g.sues)} | ended on start plane ${pct(g.endedOnStartPlane, g.sues)} | stars ${g.avgStars ?? "-"} | coming back ${g.comingBack}`;
    const list = (pairs) => pairs.map(([k, n]) => `${k} (${n})`).join(", ") || "-";
    console.log(`where Sues end up, since ${report.since}`);
    console.log(line("ALL", report.all));
    for (const [reason, g] of Object.entries(report.byReason)) {
      console.log(`\n${line(reason, g)}`);
      console.log(`   started on: ${list(g.startPlanes)}`);
      console.log(`   ended at:   ${list(g.endedAt)}`);
      console.log(`   the ones with an account ended at: ${list(g.endedWithAccount)}`);
      console.log(`   after sign-up the site sent them to: ${list(g.sentAfterSignup)}`);
      console.log(`   after sign-up they went to: ${list(g.wentAfterSignup)}`);
    }
  }
}

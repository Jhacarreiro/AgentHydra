#!/usr/bin/env bun
// dredd/follow-burndown.mjs - follow a burn-down list to done (lib/burndown-follow.mjs). Each item's state is in
// burndown-status.json beside the docket's burndown.json.
//
//   next   --docket <dir> [--item B<n>] [--take]   the next open or reopened item's standalone brief (or the named item's,
//          a reopened one back to its builder), for a builder (a CliMayte worker, climayte_run); --take marks it building
//          so the next call hands out the one after it
//   built  --docket <dir> --item B<n> --commit <sha> --repo <the product's checkout> [--force]    records a build (older than the recorded one: refused)
//   review --docket <dir> --item B<n> [--url <base>] [--path <page>[,<page>]] [--after <png>[,...]] [--capture-only]
//          [-- <phone-render flags>]   captures the item's pages headless at 390x844 and 1280x800 (scripts/ui/phone-render.mjs;
//          --url defaults to the list's product URL, flags after -- such as --step "tap:text=Add all Kitchen" are
//          kept for the next review), its experts judge them, and PARTLY or NOT SOLVED reopens it with their NEXT lines
//   status --docket <dir>              the board
import path from "node:path";

import { closeBrain } from "./lib/brain.mjs";
import { followBuilt, followNext, followReview, followRule, followStatus } from "./lib/burndown-follow.mjs";
import { runAsync } from "./lib/collect.mjs";

const USAGE =
  "usage: bun dredd/follow-burndown.mjs (next [--item B<n>] [--take] | built --item B<n> --commit <sha> --repo <dir> | review --item B<n> [...] | rule --item B<n> --keep \"<reason>\" | status) --docket <dir>";

function flags(argv) {
  const cut = argv.indexOf("--");
  const own = cut < 0 ? argv : argv.slice(0, cut);
  const a = { command: own[0], args: cut < 0 ? null : argv.slice(cut + 1) };
  const list = (v) =>
    String(v || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  for (let i = 1; i < own.length; i += 1) {
    const x = own[i];
    const next = () => own[++i];
    if (x === "--docket") a.docket = path.resolve(next());
    else if (x === "--item") a.item = String(next()).toUpperCase();
    else if (x === "--commit") a.commit = next();
    else if (x === "--repo") a.repo = path.resolve(next());
    else if (x === "--url") a.url = next();
    else if (x === "--path") a.paths = list(next());
    else if (x === "--after") a.after = list(next()).map((p) => path.resolve(p));
    else if (x === "--take") a.take = true;
    else if (x === "--keep") a.keep = next();
    else if (x === "--force") a.force = true;
    else if (x === "--capture-only") a.captureOnly = true;
    else throw new Error(`unknown flag ${x}\n${USAGE}`);
  }
  if (!["next", "built", "review", "rule", "status"].includes(a.command)) throw new Error(USAGE);
  if (!a.docket) throw new Error(`--docket <dir> is required\n${USAGE}`);
  if (["built", "review", "rule"].includes(a.command) && !a.item) throw new Error(`${a.command} needs --item B<n>`);
  if (a.command === "rule" && !a.keep) throw new Error(`rule needs --keep "<reason>"
${USAGE}`);
  return a;
}

async function main(argv) {
  const a = flags(argv);
  const log = (line) => process.stdout.write(`${line}\n`);
  if (a.command === "status") {
    followStatus({ docketDir: a.docket }).forEach((l) => log(l));
  } else if (a.command === "next") {
    const got = followNext({ docketDir: a.docket, itemId: a.item ?? null, take: Boolean(a.take) });
    if (!got) log("Nothing left to build: every item is building, built or solved (status shows the board).");
    else log(got.brief);
  } else if (a.command === "rule") {
    const { item, entry } = followRule({ docketDir: a.docket, itemId: a.item, reason: a.keep });
    log(`${item.id} held: ${entry.held.reason}; next passes over it until a build clears the hold`);
  } else if (a.command === "built") {
    const { item, entry } = followBuilt({ docketDir: a.docket, itemId: a.item, commit: a.commit, repo: a.repo, force: Boolean(a.force) });
    const b = entry.builds.at(-1);
    log(`${item.id} built: ${b.short} ${b.subject} (${b.repo}); review it with: review --docket ${a.docket} --item ${item.id}`);
  } else {
    const r = await followReview({
      docketDir: a.docket,
      itemId: a.item,
      url: a.url ?? null,
      paths: a.paths ?? null,
      args: a.args,
      after: a.after ?? null,
      captureOnly: Boolean(a.captureOnly),
      run: runAsync,
      log,
    });
    if (a.captureOnly) {
      log(`captured ${r.item.id} (nothing asked, nothing recorded):`);
      r.shots.forEach((s) => log(`  ${s}`));
      if (r.served) log(`served: ${JSON.stringify(r.served)}`);
      return;
    }
    const last = r.entry.reviews.at(-1);
    log(`${r.item.id}: ${last.verdict} -> ${r.entry.status}; ${last.file}; $${last.cost_usd ?? "?"}, ${last.seconds ?? "?"} s`);
    if (last.errors?.length) last.errors.forEach((e) => log(`  no answer: ${e}`));
    if (r.entry.status === "reopened") last.next.forEach((n) => log(`  NEXT ${n.seat}: ${n.next}`));
  }
}

main(process.argv.slice(2))
  .catch((err) => {
    process.stderr.write(`follow-burndown: ${err?.message || err}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeBrain());

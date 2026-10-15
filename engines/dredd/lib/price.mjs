// dredd/lib/price.mjs - the price check instrument's CLI: where it is, and the feedback a wrong price rating sends.
//
// Feedback is best effort. A missing CLI or a failed call is reported back to the rating's caller and never throws,
// so a rating is never lost to pricecheck being absent.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pricecheck lives in this repo (private), so the default is this checkout's own copy.
const DEFAULT_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pricecheck", "bin", "pricecheck.mjs");

export function pricecheckCli() {
  return process.env.PRICECHECK_CLI || DEFAULT_CLI;
}

function priceClaim(docketDir, docket) {
  try {
    const top = JSON.parse(readFileSync(path.join(docketDir, "price.json"), "utf8")).pages?.[0];
    if (top) return `${top.page} is the dearest page at ${top.points} points`;
  } catch {
    // no scan was written, so the claim names the docket instead
  }
  return `the price check of docket ${docket.id} named no page`;
}

export function reportPriceFeedback({ cli = pricecheckCli(), claim, why, root }) {
  const args = [cli, "feedback", "--verdict", "wrong", "--claim", claim, "--why", why, "--by", "dredd", "--root", root];
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30000, windowsHide: true });
  const ok = run.status === 0;
  return { ok, why: ok ? null : (run.error?.message || run.stderr || `exit ${run.status}`).trim() };
}

export function priceFeedbackFor({ docket, rating, docketDir, root, cli = pricecheckCli() }) {
  if (rating.choices?.price !== "wrong") return null;
  return reportPriceFeedback({ cli, claim: priceClaim(docketDir, docket), why: rating.note || "", root });
}

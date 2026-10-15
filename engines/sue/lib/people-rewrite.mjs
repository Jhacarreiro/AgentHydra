// One persona rewrite: ask the engine's brain for a new persona doc aimed at one direction, keep it only if the A/B reads better.
import { appendFileSync } from "node:fs";

import { buildPreflightArgs, SUE_DEFAULT_MODEL, spawnBrain } from "./claude-cli.mjs";
import { savePeople } from "./people.mjs";

const REWRITE_TIMEOUT_MS = 300_000;

export function buildRewritePrompt({ doc, direction, evidence = [] }) {
  return [
    "Rewrite this Sue persona doc. Keep the id exactly as it is and keep displayName.",
    `Direction: ${direction}`,
    evidence.length ? `Why it was picked: ${evidence.join("; ")}` : "",
    "Change only what the direction needs. Answer with the full doc as one JSON object and nothing else.",
    "",
    JSON.stringify(doc, null, 2),
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseRewrite(text, id) {
  const body = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("the rewrite is not JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("the rewrite is not a persona doc");
  if (doc.id !== id) throw new Error(`the rewrite must keep the id ${id}, not ${JSON.stringify(doc.id)}`);
  if (typeof doc.displayName !== "string" || !doc.displayName.trim()) throw new Error("the rewrite has no displayName");
  return doc;
}

export function decideRewrite({ verdict }) {
  if (verdict === "better") return { keep: true, why: "the A/B reads better" };
  return { keep: false, why: `the A/B reads ${verdict}: revert to the prior version` };
}

export function revertItem(priorDoc, now) {
  return { doc: priorDoc, updatedAt: new Date(Date.parse(now) + 1000).toISOString() };
}

export async function askRewrite({ doc, direction, evidence, model = SUE_DEFAULT_MODEL, cwd = process.cwd() }) {
  const { done } = spawnBrain({
    args: buildPreflightArgs({ model }),
    cwd,
    input: buildRewritePrompt({ doc, direction, evidence }),
    timeoutMs: REWRITE_TIMEOUT_MS,
  });
  const out = await done;
  if (out.timedOut || out.code !== 0) throw new Error(`the rewrite brain did not answer: ${out.stderr || `exit ${out.code}`}`);
  return parseRewrite(out.result?.result, doc.id);
}

export async function rewritePersona({
  door,
  prior,
  direction,
  evidence = [],
  verdict = "unmeasured",
  comparison = null,
  ask = askRewrite,
  ledgerFile,
  now = new Date().toISOString(),
}) {
  const next = await ask({ doc: prior, direction, evidence });
  const { keep, why } = comparison ? { keep: comparison.verdict === "better", why: comparison.why } : decideRewrite({ verdict });
  const shownVerdict = comparison ? comparison.verdict : verdict;
  await savePeople(door, [{ doc: next, updatedAt: now }]);
  if (!keep) await savePeople(door, [revertItem(prior, now)]);
  const row = {
    kind: "persona-rewrite",
    at: now,
    persona: prior.id,
    direction,
    evidence,
    verdict: shownVerdict,
    decision: keep ? "kept" : "reverted",
    why,
  };
  if (ledgerFile) appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`);
  return { row, kept: keep, next };
}

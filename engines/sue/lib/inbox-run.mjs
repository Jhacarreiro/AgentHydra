/**
 * inbox-run - the inbox test's collect step: each Sue's presses on the arrival are read back from her own
 * mailbox, turned into one final disposition, rated over the run, given a verdict, and booked under the
 * email's content hash. It only reads files and appends one line; the run itself is started by sue.mjs.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ARRIVAL_ID } from "./findings.mjs";
import { contentHashOf, dispositionOf, mergeCompleteOf, mergeTokensOf, rates, unsubscribeUrlOf, verdictOf } from "./inbox-test.mjs";

function eventsOf(file) {
  if (!existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A line cut short when a Sue's run was stopped mid-press is not a press.
    }
  }
  return events;
}

/** One `{ sue, outcome, via, why }` per Sue who has a mailbox in this run, in folder order. */
export function readRunDispositions(mailRoot) {
  if (!existsSync(mailRoot)) return [];
  return readdirSync(mailRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ sue: entry.name, ...dispositionOf(eventsOf(path.join(mailRoot, entry.name, `${ARRIVAL_ID}.events.jsonl`))) }));
}

export function inboxRunResult(mailRoot, email) {
  const dispositions = readRunDispositions(mailRoot);
  const summary = rates(dispositions);
  const spam = dispositions.filter((d) => d.outcome === "reported-spam").length;
  return { key: contentHashOf(email), ...summary, dispositions, verdict: verdictOf({ spam, count: dispositions.length }) };
}

/** Appends one verdict line to the inbox-test ledger. Dispositions stay in the run's own folder, not here. */
export function bookInboxTest(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  const { dispositions: _dispositions, ...kept } = record;
  appendFileSync(file, `${JSON.stringify({ ...kept, at: new Date().toISOString() })}\n`);
}

/** Each Sue's seeded copy of the email, as it was written into her mailbox. */
function readRunArrivals(mailRoot) {
  if (!existsSync(mailRoot)) return [];
  return readdirSync(mailRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(mailRoot, entry.name, `${ARRIVAL_ID}.json`))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")));
}

/** The result of one run plus the line that books it: merge facts and unsubscribe host read from the run itself. */
export function inboxTestRecord(mailRoot, email, { runId, audience }) {
  const result = inboxRunResult(mailRoot, email);
  const unsubscribe = unsubscribeUrlOf(email);
  const arrivals = readRunArrivals(mailRoot);
  const record = {
    runId,
    audience,
    perSueMerge: mergeTokensOf(email).includes("first_name"),
    mergeComplete: arrivals.length === result.count && mergeCompleteOf(email, arrivals),
    unsubscribeHost: unsubscribe ? new URL(unsubscribe).host : null,
    ...result,
  };
  return { result, record };
}

/**
 * pages-stars.spec - the Pages view shows the page's all-time stars.
 * ==========================================================================================
 *
 * WHAT: `node --test sue/tests/pages-stars.spec.mjs`. It pins the
 * two halves of the fix: `updateScoreboard` keeps the all-time average on its own running sum and
 * count (so the 50-run history never drops an old run, and only Sues who actually gave a rating
 * weigh in), and `workspacePages` reads `averageStarsAllTime` instead of the `averageStars` the
 * scoreboard never writes.
 *
 * WHY IT EXISTS: before the fix the Manager's Pages view showed the LATEST run's average as the
 * page's stars, because `workspacePages` read `p.averageStars` (always undefined) and fell back to
 * `history.at(-1).averageStars`, while the all-time average was computed as a Sue-weighted mean of
 * run averages and never surfaced (sue-report-pages-stars-field-mismatch).
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { scoreboardFile, updateScoreboard } from "../lib/workspace.mjs";
import { workspacePages } from "../lib/workspaces.mjs";

const INTENT = "a friend posted this link in his WhatsApp group; you want to post your deals there";

const made = [];
function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sue-stars-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

test("the all-time average counts each rated Sue once, never the Sues who gave no rating", () => {
  const ws = tempWorkspace();
  const page = { key: "app.example.com/trial", url: "https://app.example.com/trial/X" };
  updateScoreboard(ws, { page, runId: "a", intent: INTENT, at: "2026-09-21T00:00:00Z", entries: [{ stars: 5 }, { stars: 5 }] });
  const row = updateScoreboard(ws, { page, runId: "b", intent: INTENT, at: "2026-09-21T01:00:00Z", entries: [{ stars: 1 }, {}, {}, {}] });
  assert.equal(row.starsCounted, 3, "three Sues rated across both runs, not six Sues");
  assert.equal(row.starsSummed, 11, "5 + 5 + 1");
  assert.equal(
    row.averageStarsAllTime,
    3.67,
    "(5 + 5 + 1) / 3 rated Sues - not the Sue-weighted mean of run averages ((5*2 + 1*4) / 6 = 2.33)",
  );
});

test("the all-time average survives more than 50 runs: the 50-run history never drops an old rating", () => {
  const ws = tempWorkspace();
  const page = { key: "app.example.com/trial", url: "https://app.example.com/trial/X" };
  updateScoreboard(ws, { page, runId: "run-0", intent: INTENT, at: "2026-09-21T00:00:00Z", entries: [{ stars: 5 }] });
  for (let i = 1; i <= 50; i += 1) {
    updateScoreboard(ws, {
      page,
      runId: `run-${i}`,
      intent: INTENT,
      at: `2026-09-21T00:${String(i).padStart(2, "0")}:00Z`,
      entries: [{ stars: 1 }],
    });
  }
  const row = updateScoreboard(ws, { page, runId: "run-51", intent: INTENT, at: "2026-09-21T02:00:00Z", entries: [{ stars: 1 }] });
  assert.equal(row.history.length, 50, "history stays capped at 50 runs");
  assert.equal(row.averageStarsAllTime, 1.08, "(5 + 51*1) / 52 rated Sues - the dropped first run still counts");
});

test("workspacePages shows the page's all-time average, not the latest run's average", () => {
  const ws = tempWorkspace();
  assert.deepEqual(workspacePages({ folder: ws }), [], "no scoreboard yet means no pages");
  fs.mkdirSync(path.dirname(scoreboardFile(ws)), { recursive: true });
  fs.writeFileSync(
    scoreboardFile(ws),
    JSON.stringify({
      pages: {
        "app.example.com/trial": {
          url: "https://app.example.com/trial/X",
          runs: 2,
          sues: 3,
          starsSummed: 11,
          starsCounted: 3,
          averageStarsAllTime: 3.67,
          history: [
            { runId: "a", at: "2026-09-21T00:00:00Z", sues: 2, averageStars: 5 },
            { runId: "b", at: "2026-09-21T01:00:00Z", sues: 1, averageStars: 1 },
          ],
        },
      },
    }),
  );
  const pages = workspacePages({ folder: ws });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].averageStars, 3.67, "the all-time stars, not history.at(-1).averageStars (1) and not the earlier 5");
  assert.equal(pages[0].lastRunAt, "2026-09-21T01:00:00Z", "the latest run still dates the page");
});

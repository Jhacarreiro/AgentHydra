// The Dredd reader behind Sue's Hearings tab (lib/dredd-view.mjs): it hands files from this computer to a web page by
// id, so it must refuse every id and file name that is not a shape Dredd writes, and read a sitting's debate whole.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "./fixtures/people.mjs";
import { hearingShotFile, listHearings, portraitFile, readHearing, turnsOf } from "../lib/dredd-view.mjs";

const ID = "20260925-213619-4e75";
const ROOT = fs.mkdtempSync(path.join(tmpdir(), "dredd-view-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, "hearing-"));
  const dir = path.join(root, "tmp", "dredd", ID);
  fs.mkdirSync(path.join(dir, "boardroom"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docket.json"), JSON.stringify({ ask: "Would a friend claim it?", url: "https://example.test/x" }));
  fs.writeFileSync(
    path.join(dir, "verdict.md"),
    "# Verdict\n\n## The ladder\n```\n  1. ok   Is the page broken?   sound\n  4. FAIL Can people understand it?   2.3 stars\n```\n",
  );
  fs.writeFileSync(path.join(dir, "page-desk.png"), "png");
  fs.writeFileSync(path.join(dir, "secret.txt"), "not for the page");
  fs.writeFileSync(
    path.join(dir, "boardroom", "minutes.json"),
    JSON.stringify({ title: "Trust note", room: "product", seats: ["The Copy Editor"], tally: { verdict: 4, scores: [4] } }),
  );
  fs.writeFileSync(
    path.join(dir, "boardroom", "transcript.md"),
    "# Boardroom\n\n_Held on the Connections Boardroom._\n\n**the Chair:** Score it.\n**The Copy Editor:** The note is wrong.\nIt proves nothing.\n\n---\n\n**Verdict:** 4/10\n",
  );
  return root;
}

test("a hearing reads whole: the ladder, the last sitting's verdict and every turn of the debate, stopping at the verdict", () => {
  const root = fixture();
  const [summary] = listHearings(root);
  assert.equal(summary.id, ID);
  assert.equal(summary.verdict, 4);
  assert.equal(summary.failed, 1);
  const hearing = readHearing(root, ID);
  assert.deepEqual(
    hearing.ladder.map((r) => r.state),
    ["ok", "FAIL"],
  );
  assert.deepEqual(hearing.sittingsDetail[0].turns, [
    { speaker: "the Chair", text: "Score it." },
    { speaker: "The Copy Editor", text: "The note is wrong.\nIt proves nothing." },
  ]);
  assert.deepEqual(hearing.shots, ["page-desk.png"]);
});

test("nothing but a Dredd-shaped id or file name reaches the disk", () => {
  const root = fixture();
  assert.equal(readHearing(root, "../../etc"), null);
  assert.equal(readHearing(root, `${ID}/..`), null);
  assert.equal(hearingShotFile(root, ID, "secret.txt"), null);
  assert.equal(hearingShotFile(root, ID, "../verdict.md"), null);
  assert.equal(hearingShotFile(root, "..", "page-desk.png"), null);
  assert.equal(portraitFile("../../x"), null);
  assert.ok(hearingShotFile(root, ID, "page-desk.png"));
});

test("a transcript with no debate reads as no turns", () => {
  assert.deepEqual(turnsOf("---\n**Verdict:** 4/10"), []);
  assert.deepEqual(turnsOf(null), []);
});

test("a seat that speaks as one of SUE's people wears her portrait", () => {
  const root = fs.mkdtempSync(path.join(ROOT, "portrait-"));
  fs.mkdirSync(path.join(root, "sue", "personas", "portraits"), { recursive: true });
  fs.writeFileSync(path.join(root, "sue", "personas", "portraits", "grandma.webp"), "webp");
  const seat = { id: "grandma-sue", briefFrom: { sue: "grandma", field: "voice" } };
  assert.equal(portraitFile("grandma-sue", root, seat), path.join(root, "sue", "personas", "portraits", "grandma.webp"));
  assert.equal(portraitFile("the-architect", root, { id: "the-architect" }), null);
  assert.equal(portraitFile("x", root, { id: "x", briefFrom: { sue: "../../etc/passwd" } }), null);
});

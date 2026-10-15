/**
 * persona-extract.spec - a re-run of dredd/persona/extract.py never loses a message an earlier run found.
 * ============================================================================================================
 *
 * WHAT: `node --test dredd/tests/persona-extract.spec.mjs`. Copies extract.py into a throwaway tree (its
 * output folder is three levels above the script) and runs it against a throwaway home holding one transcript.
 *
 * WHY: Claude Code deletes old transcripts, and the extractor rewrote messages.jsonl from what was left. On
 * 2026-10-08 a re-run wrote 10,798 messages over a file of 13,470, and the persona seat lost every older message
 * until the saved copy was merged back by hand.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "persona", "extract.py");

test("a message whose transcript is gone stays, and one still on disk keeps its earlier count", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "persona-extract-"));
  try {
    const tools = path.join(tmp, "tree", "dredd", "persona");
    fs.mkdirSync(tools, { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(tools, "extract.py"));
    const out = path.join(tmp, "tree", "tmp", "dredd", "persona");
    fs.mkdirSync(out, { recursive: true });
    const earlier = [
      {
        id: "m000000",
        text: "the old one, its chat long deleted",
        count: 2,
        first_ts: "2026-05-01T00:00:00Z",
        src: "claude",
        project: "p",
        session: "s0",
        band: "human",
        chars: 34,
      },
      {
        id: "m000001",
        text: "still here",
        count: 5,
        first_ts: "2026-06-01T00:00:00Z",
        src: "claude",
        project: "p",
        session: "s1",
        band: "human",
        chars: 10,
      },
    ];
    fs.writeFileSync(path.join(out, "messages.jsonl"), earlier.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const home = path.join(tmp, "home");
    const proj = path.join(home, ".claude", "projects", "p");
    fs.mkdirSync(proj, { recursive: true });
    const line = (uuid, text, ts) =>
      JSON.stringify({ type: "user", uuid, sessionId: "s2", timestamp: ts, entrypoint: "cli", message: { content: text } });
    fs.writeFileSync(
      path.join(proj, "s2.jsonl"),
      [line("u1", "still here", "2026-10-01T00:00:00Z"), line("u2", "a new one", "2026-10-02T00:00:00Z")].join("\n") + "\n",
    );

    const r = spawnSync("python", ["-I", path.join(tools, "extract.py")], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);

    const rows = fs
      .readFileSync(path.join(out, "messages.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const by = Object.fromEntries(rows.map((row) => [row.text, row]));
    assert.deepEqual(Object.keys(by).sort(), ["a new one", "still here", "the old one, its chat long deleted"]);
    assert.equal(by["still here"].count, 5, "the earlier count stands when fewer transcripts are left");
    assert.equal(by["still here"].first_ts, "2026-06-01T00:00:00Z", "the earliest sighting stands");
    assert.equal(by["the old one, its chat long deleted"].count, 2);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["m000000", "m000001", "m000002"],
      "ids follow first sighting",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

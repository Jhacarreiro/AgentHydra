// apiAnswer: what a caller of the local MCP's connections_execute gets back, whole or honestly empty - never a cut
// string passed off as the whole one (2026-09-28: a 323,853-character adviser playbook arrived as its first 20,000).
import assert from "node:assert/strict";
import { test } from "node:test";

import { apiAnswer, localAnswer } from "../lib/mcp.mjs";

const PLAYBOOK = `# Film Editor's playbook\n\n${"## Cut for emotion\nTags: edit\nEmotion first.\n\n".repeat(20)}`;
const whole = { status: 200, body: { persona: { id: "p-1", playbook: PLAYBOOK } } };
const cutEnvelope = (extra) =>
  JSON.stringify({
    status: 200,
    body: { persona: { id: "p-1", playbook: `${PLAYBOOK.slice(0, 40)}…[+${PLAYBOOK.length - 40} characters]` } },
    truncated: true,
    truncatedPhase: "strings",
    ...extra,
  });

test("a whole answer is its body", () => {
  const out = apiAnswer(JSON.stringify(whole), "boardroom_personas_get");
  assert.equal(out.ok, true);
  assert.equal(out.body.persona.playbook, PLAYBOOK);
});

test("a cut answer is read whole from the original the MCP saved on this machine", () => {
  const reads = [];
  const out = apiAnswer(cutEnvelope({ savedTo: "C:/spill/out-1.txt" }), "boardroom_personas_get", (file) => {
    reads.push(file);
    return JSON.stringify(whole, null, 2);
  });
  assert.deepEqual(reads, ["C:/spill/out-1.txt"]);
  assert.equal(out.ok, true);
  assert.equal(out.body.persona.playbook, PLAYBOOK);
  assert.equal(out.truncated, undefined);
});

test("a cut answer with no readable original has no body, and a 2xx stays a success", () => {
  for (const [extra, read] of [
    [{}, () => assert.fail("nothing to read")],
    [
      { savedTo: "C:/spill/gone.txt" },
      () => {
        throw new Error("ENOENT");
      },
    ],
  ]) {
    const out = apiAnswer(cutEnvelope(extra), "boardroom_personas_get", read);
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.equal(out.body, null);
    assert.equal(out.truncated, true);
  }
});

// 2026-09-30: a 324,587-character playbook came back cut past every JSON phase, its original named only by handle, and the
// saved original ends with the MCP's license notice after the JSON - skill-advisers.mjs read "no body" and crashed.
test("an answer cut mid-string is read whole from the original its handle names, notice and all", () => {
  const reads = [];
  const cutText = `{"status": 200, "body": {"persona": {"playbook": "${"x".repeat(200_000)} [answer cut - handle:"out-0123456789abcdef", offset]`;
  const out = apiAnswer(cutText, "boardroom_personas_get", (file) => {
    reads.push(file.replace(/\\/g, "/"));
    return `${JSON.stringify(whole, null, 2)}\n\nConnections license notice: proprietary.`;
  });
  assert.equal(reads.length, 1);
  assert.match(reads[0], /\/\.connections\/tool-results\/out-0123456789abcdef\.txt$/);
  assert.deepEqual([out.ok, out.status, out.truncated], [true, 200, undefined]);
  assert.equal(out.body.persona.playbook, PLAYBOOK);
});

test("an answer cut mid-string keeps its status and has no body; anything else is unreadable", () => {
  const cut = apiAnswer(`{"status": 201, "body": {"persona": {"playbook": "${"x".repeat(200_000)}`, "boardroom_personas_create");
  assert.deepEqual([cut.ok, cut.status, cut.body, cut.truncated], [true, 201, null, true]);
  const junk = apiAnswer("not json", "boardroom_personas_get");
  assert.deepEqual([junk.ok, junk.status, junk.body], [false, null, null]);
});

// 2026-10-04: this machine's Connections sign-in lapsed, and Lift's deploy (cloudflare_worker_deploy through this
// client) printed the MCP's sign-in prompt and passed as deployed; only the live-version check saw nothing shipped.
test("a local tool the MCP answered with its sign-in prompt did not run", () => {
  const prompt =
    "🔐 Still waiting for you to finish signing in. Open this in your browser:\n  https://accounts.example/activate\n\nCode: AB-CD";
  assert.deepEqual(localAnswer({ result: { content: [{ type: "text", text: prompt }] } }), { ok: false, text: prompt });
  assert.deepEqual(localAnswer({ result: { content: [{ type: "text", text: "deployed future-that-works-lift" }] } }), {
    ok: true,
    text: "deployed future-that-works-lift",
  });
  assert.equal(localAnswer({ result: { content: [{ type: "text", text: "no such script" }], isError: true } }).ok, false);
});
